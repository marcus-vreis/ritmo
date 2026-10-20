use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

const ARG_MINIMIZADO: &str = "--minimizado";
const ARQUIVOS: [&str; 2] = ["config.json", "estado.json"];

/// Alarmes nomeados ("timer", "ancora"). Reagendar uma chave invalida o alarme anterior dela.
#[derive(Default)]
struct Alarmes {
    geracao: AtomicU64,
    ativos: Mutex<HashMap<String, u64>>,
}

/// Pasta dos dados do usuário: %APPDATA%\ritmo
fn pasta(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().config_dir().map_err(|e| e.to_string())?.join("ritmo");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn caminho(app: &AppHandle, nome: &str) -> Result<PathBuf, String> {
    if !ARQUIVOS.contains(&nome) {
        return Err(format!("arquivo não permitido: {nome}"));
    }
    Ok(pasta(app)?.join(nome))
}

#[tauri::command]
fn ler_arquivo(app: AppHandle, nome: String) -> Result<Option<String>, String> {
    let p = caminho(&app, &nome)?;
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
}

/// Escreve num temporário e renomeia, para não corromper o arquivo se o app fechar no meio.
#[tauri::command]
fn salvar_arquivo(app: AppHandle, nome: String, conteudo: String) -> Result<(), String> {
    let p = caminho(&app, &nome)?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, conteudo).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn abrir_pasta(app: AppHandle) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(pasta(&app)?)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Agenda uma notificação nativa para `quando_ms` (epoch em ms) e emite "alarme" com a chave.
/// Roda no Rust para disparar na hora mesmo com a janela principal escondida.
#[tauri::command]
fn agendar(app: AppHandle, chave: String, quando_ms: u64, titulo: String, corpo: String) {
    let estado = app.state::<Alarmes>();
    let geracao = estado.geracao.fetch_add(1, Ordering::SeqCst) + 1;
    estado.ativos.lock().unwrap().insert(chave.clone(), geracao);
    let app = app.clone();
    thread::spawn(move || {
        let agora = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        thread::sleep(Duration::from_millis(quando_ms.saturating_sub(agora)));
        let estado = app.state::<Alarmes>();
        let vale = estado.ativos.lock().unwrap().get(&chave) == Some(&geracao);
        if vale {
            estado.ativos.lock().unwrap().remove(&chave);
            let _ = app.notification().builder().title(titulo).body(corpo).show();
            let _ = app.emit("alarme", chave);
        }
    });
}

#[tauri::command]
fn cancelar(app: AppHandle, chave: String) {
    app.state::<Alarmes>().ativos.lock().unwrap().remove(&chave);
}

/// Sem argumento: lê o estado. Com `ligar`: liga/desliga e devolve o estado novo.
#[tauri::command]
fn autostart(app: AppHandle, ligar: Option<bool>) -> Result<bool, String> {
    let m = app.autolaunch();
    match ligar {
        Some(true) => m.enable().map_err(|e| e.to_string())?,
        Some(false) => m.disable().map_err(|e| e.to_string())?,
        None => {}
    }
    m.is_enabled().map_err(|e| e.to_string())
}

/// Sem argumento: alterna. Devolve se o widget ficou visível.
#[tauri::command]
fn widget(app: AppHandle, mostrar: Option<bool>) -> Result<bool, String> {
    let w = app.get_webview_window("mini").ok_or("widget não existe")?;
    let visivel = w.is_visible().map_err(|e| e.to_string())?;
    let alvo = mostrar.unwrap_or(!visivel);
    if alvo {
        if !visivel {
            posicionar_widget(&app);
        }
        w.show().map_err(|e| e.to_string())?;
    } else {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(alvo)
}

/// Canto superior direito do monitor da janela principal, na primeira vez.
fn posicionar_widget(app: &AppHandle) {
    static POSICIONADO: std::sync::Once = std::sync::Once::new();
    POSICIONADO.call_once(|| {
        let (Some(main), Some(mini)) = (app.get_webview_window("main"), app.get_webview_window("mini")) else { return };
        let Ok(Some(mon)) = main.current_monitor().or_else(|_| main.primary_monitor()) else { return };
        let Ok(tam) = mini.outer_size() else { return };
        let area = mon.work_area();
        let margem = (16.0 * mon.scale_factor()) as i32;
        let x = area.position.x + area.size.width as i32 - tam.width as i32 - margem;
        let y = area.position.y + margem;
        let _ = mini.set_position(PhysicalPosition::new(x, y));
    });
}

#[tauri::command]
fn mostrar_principal(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // Precisa ser o primeiro plugin: abrir o app de novo só traz a janela existente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            mostrar_principal(app.clone());
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![ARG_MINIMIZADO])))
        .manage(Alarmes::default())
        .invoke_handler(tauri::generate_handler![
            ler_arquivo,
            salvar_arquivo,
            abrir_pasta,
            agendar,
            cancelar,
            autostart,
            widget,
            mostrar_principal
        ])
        .setup(|app| {
            let abrir = MenuItemBuilder::with_id("abrir", "Abrir o ritmo").build(app)?;
            let foco = MenuItemBuilder::with_id("foco", "Iniciar foco").build(app)?;
            let widget_item = MenuItemBuilder::with_id("widget", "Mostrar/ocultar widget").build(app)?;
            let sair = MenuItemBuilder::with_id("sair", "Sair").build(app)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = MenuBuilder::new(app).items(&[&abrir, &foco, &widget_item, &sep, &sair]).build()?;

            TrayIconBuilder::with_id("ritmo")
                .icon(app.default_window_icon().cloned().ok_or("sem ícone")?)
                .tooltip("ritmo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "abrir" => mostrar_principal(app.clone()),
                    "foco" => {
                        mostrar_principal(app.clone());
                        let _ = app.emit("navegar", "foco");
                    }
                    "widget" => {
                        let _ = widget(app.clone(), None);
                    }
                    "sair" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        mostrar_principal(tray.app_handle().clone());
                    }
                })
                .build(app)?;

            // Iniciado pelo Windows: só o widget. Aberto pela pessoa: a janela principal.
            if std::env::args().any(|a| a == ARG_MINIMIZADO) {
                let _ = widget(app.handle().clone(), Some(true));
            } else {
                mostrar_principal(app.handle().clone());
            }
            Ok(())
        })
        // Fechar qualquer janela só esconde; sair é pelo menu da bandeja.
        .on_window_event(|janela, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = janela.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o ritmo");
}
