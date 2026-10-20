//! Leitura do hardware (GPU NVIDIA via NVML; CPU, RAM e discos via sysinfo) a cada 2 s,
//! emitida para as janelas como evento "sistema", e detector de "a GPU parou".

use std::{
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nvml_wrapper::{
    enum_wrappers::device::{Clock, TemperatureSensor},
    enums::device::UsedGpuMemory,
    Nvml,
};
use serde::Serialize;
use sysinfo::{Disks, Pid, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

const INTERVALO: Duration = Duration::from_secs(2);

/// No Windows a NVML lista como "computação" todo programa com contexto na GPU (Explorer,
/// navegadores...). Só estes executáveis contam como treino/cálculo; o resto vira contagem.
const RUNTIMES: [&str; 14] = [
    "python.exe", "python3.exe", "pythonw.exe", "py.exe", "conda.exe", "jupyter.exe", "julia.exe",
    "ollama.exe", "ollama_llama_server.exe", "llama-server.exe", "matlab.exe", "blender.exe",
    "ffmpeg.exe", "torchrun.exe",
];

pub fn e_runtime(nome: &str) -> bool {
    RUNTIMES.iter().any(|r| r.eq_ignore_ascii_case(nome))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Processo {
    pid: u32,
    nome: String,
    /// No Windows (WDDM) o driver não informa a VRAM por processo: vem `None`.
    vram: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    nome: String,
    uso: u32,
    uso_memoria: u32,
    vram_usada: u64,
    vram_total: u64,
    temperatura: Option<u32>,
    potencia_w: Option<f32>,
    limite_w: Option<f32>,
    clock_sm: Option<u32>,
    clock_memoria: Option<u32>,
    ventoinha: Option<u32>,
    processos: Vec<Processo>,
    /// Outros programas com contexto na GPU (janelas, navegadores...).
    outros_processos: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Disco {
    ponto: String,
    livre: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Amostra {
    ts: u64,
    gpus: Vec<Gpu>,
    gpu_erro: Option<String>,
    cpu: f32,
    ram_usada: u64,
    ram_total: u64,
    discos: Vec<Disco>,
}

/// Um período de GPU ocupada que terminou (treino acabou ou caiu).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ciclo {
    pub inicio_ms: u64,
    pub fim_ms: u64,
    pub processos: Vec<String>,
}

/// Detector: a GPU conta como "em uso longo" depois de `MIN_OCUPADA` com uso ≥ `ALTO`,
/// tolerando quedas curtas; o ciclo fecha depois de `MIN_OCIOSA` seguida com uso < `BAIXO`.
pub struct Detector {
    ocupada_s: f64,
    ociosa_s: f64,
    inicio_ms: Option<u64>,
    armado: bool,
    processos: Vec<String>,
}

impl Detector {
    pub const ALTO: u32 = 50;
    pub const BAIXO: u32 = 10;
    pub const MIN_OCUPADA_S: f64 = 600.0;
    pub const MIN_OCIOSA_S: f64 = 300.0;

    pub fn new() -> Self {
        Self { ocupada_s: 0.0, ociosa_s: 0.0, inicio_ms: None, armado: false, processos: vec![] }
    }

    pub fn armado(&self) -> bool {
        self.armado
    }

    /// `agora_ms`: instante da amostra; `dt_s`: segundos desde a anterior.
    pub fn passo(&mut self, uso: u32, dt_s: f64, agora_ms: u64, processos: &[String]) -> Option<Ciclo> {
        if uso >= Self::ALTO {
            if self.inicio_ms.is_none() {
                self.inicio_ms = Some(agora_ms.saturating_sub((dt_s * 1000.0) as u64));
            }
            self.ocupada_s += dt_s;
            self.ociosa_s = 0.0;
            for p in processos {
                if !self.processos.contains(p) {
                    self.processos.push(p.clone());
                }
            }
            if self.ocupada_s >= Self::MIN_OCUPADA_S {
                self.armado = true;
            }
        } else if uso < Self::BAIXO {
            self.ociosa_s += dt_s;
            if self.ociosa_s >= Self::MIN_OCIOSA_S {
                let ciclo = self.armado.then(|| Ciclo {
                    inicio_ms: self.inicio_ms.unwrap_or(agora_ms),
                    fim_ms: agora_ms - (self.ociosa_s * 1000.0) as u64,
                    processos: std::mem::take(&mut self.processos),
                });
                *self = Self::new();
                return ciclo;
            }
        }
        None
    }
}

fn agora_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn ler_gpus(nvml: &Nvml, sys: &mut System) -> Vec<Gpu> {
    let n = nvml.device_count().unwrap_or(0);
    let mut gpus = vec![];
    for i in 0..n {
        let Ok(d) = nvml.device_by_index(i) else { continue };
        let util = d.utilization_rates().ok();
        let mem = d.memory_info().ok();
        let procs = d.running_compute_processes().unwrap_or_default();
        let pids: Vec<Pid> = procs.iter().map(|p| Pid::from_u32(p.pid)).collect();
        if !pids.is_empty() {
            sys.refresh_processes(ProcessesToUpdate::Some(&pids), true);
        }
        let todos: Vec<Processo> = procs
            .iter()
            .map(|p| Processo {
                pid: p.pid,
                nome: sys
                    .process(Pid::from_u32(p.pid))
                    .map(|x| x.name().to_string_lossy().into_owned())
                    .unwrap_or_else(|| format!("pid {}", p.pid)),
                vram: match p.used_gpu_memory {
                    UsedGpuMemory::Used(b) => Some(b),
                    UsedGpuMemory::Unavailable => None,
                },
            })
            .collect();
        let (processos, outros): (Vec<Processo>, Vec<Processo>) = todos.into_iter().partition(|p| e_runtime(&p.nome));
        gpus.push(Gpu {
            nome: d.name().unwrap_or_else(|_| format!("GPU {i}")),
            uso: util.as_ref().map_or(0, |u| u.gpu),
            uso_memoria: util.as_ref().map_or(0, |u| u.memory),
            vram_usada: mem.as_ref().map_or(0, |m| m.used),
            vram_total: mem.as_ref().map_or(0, |m| m.total),
            temperatura: d.temperature(TemperatureSensor::Gpu).ok(),
            potencia_w: d.power_usage().ok().map(|mw| mw as f32 / 1000.0),
            limite_w: d.enforced_power_limit().ok().map(|mw| mw as f32 / 1000.0),
            clock_sm: d.clock_info(Clock::SM).ok(),
            clock_memoria: d.clock_info(Clock::Memory).ok(),
            ventoinha: d.fan_speed(0).ok(),
            processos,
            outros_processos: outros.len(),
        });
    }
    gpus
}

/// Inicia a thread de leitura. Roda enquanto o app estiver aberto.
pub fn iniciar(app: AppHandle) {
    thread::spawn(move || {
        let nvml = Nvml::init();
        let gpu_erro = nvml.as_ref().err().map(|e| e.to_string());
        let mut sys = System::new();
        let mut discos = Disks::new_with_refreshed_list();
        let mut detector = Detector::new();
        let mut ultimo = agora_ms();
        let mut volta: u64 = 0;
        loop {
            thread::sleep(INTERVALO);
            let ts = agora_ms();
            let dt = (ts - ultimo) as f64 / 1000.0;
            ultimo = ts;
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            if volta % 15 == 0 {
                discos.refresh(true);
            }
            volta += 1;
            let gpus = nvml.as_ref().map(|n| ler_gpus(n, &mut sys)).unwrap_or_default();

            if let Some(g) = gpus.first() {
                let nomes: Vec<String> = g.processos.iter().map(|p| p.nome.clone()).collect();
                if let Some(c) = detector.passo(g.uso, dt, ts, &nomes) {
                    let horas = (c.fim_ms - c.inicio_ms) as f64 / 3_600_000.0;
                    let quem = if c.processos.is_empty() { String::new() } else { format!(" ({})", c.processos.join(", ")) };
                    let _ = app
                        .notification()
                        .builder()
                        .title("A GPU parou")
                        .body(format!("Ficou ocupada {:.1} h e está ociosa há 5 min{quem}. O treino acabou ou caiu?", horas))
                        .show();
                    let _ = app.emit("gpu-ciclo", c);
                }
            }

            let amostra = Amostra {
                ts,
                gpus,
                gpu_erro: gpu_erro.clone(),
                cpu: sys.global_cpu_usage(),
                ram_usada: sys.used_memory(),
                ram_total: sys.total_memory(),
                discos: discos
                    .list()
                    .iter()
                    .map(|d| Disco {
                        ponto: d.mount_point().to_string_lossy().into_owned(),
                        livre: d.available_space(),
                        total: d.total_space(),
                    })
                    .collect(),
            };
            let _ = app.emit("sistema", (amostra, detector.armado()));
        }
    });
}

#[cfg(test)]
mod testes {
    use super::*;

    fn rodar(d: &mut Detector, uso: u32, segundos: u64, t: &mut u64) -> Option<Ciclo> {
        let mut saida = None;
        for _ in 0..(segundos / 2) {
            *t += 2000;
            if let Some(c) = d.passo(uso, 2.0, *t, &["python.exe".to_string()]) {
                saida = Some(c);
            }
        }
        saida
    }

    #[test]
    fn so_runtimes_contam_como_treino() {
        assert!(e_runtime("python.exe"));
        assert!(e_runtime("Python.EXE"));
        assert!(!e_runtime("explorer.exe"));
        assert!(!e_runtime("chrome.exe"));
    }

    #[test]
    fn treino_longo_que_para_fecha_um_ciclo() {
        let (mut d, mut t) = (Detector::new(), 0);
        assert!(rodar(&mut d, 98, 3600, &mut t).is_none());
        assert!(d.armado());
        let c = rodar(&mut d, 0, 300, &mut t).expect("deveria avisar depois de 5 min ociosa");
        assert_eq!(c.processos, vec!["python.exe"]);
        assert_eq!(c.inicio_ms, 0);
        assert_eq!(c.fim_ms, 3_600_000);
        assert!(!d.armado());
    }

    #[test]
    fn uso_curto_nao_avisa() {
        let (mut d, mut t) = (Detector::new(), 0);
        rodar(&mut d, 98, 300, &mut t); // 5 min: abaixo do mínimo de 10
        assert!(rodar(&mut d, 0, 600, &mut t).is_none());
    }

    #[test]
    fn queda_curta_no_meio_nao_fecha_o_ciclo() {
        let (mut d, mut t) = (Detector::new(), 0);
        rodar(&mut d, 98, 1200, &mut t);
        assert!(rodar(&mut d, 0, 120, &mut t).is_none()); // 2 min ociosa (ex.: validação na CPU)
        rodar(&mut d, 98, 600, &mut t);
        let c = rodar(&mut d, 0, 300, &mut t).expect("fecha só no fim");
        assert_eq!(c.fim_ms, 1_920_000);
    }

    #[test]
    fn uso_intermediario_nao_conta_como_ocioso() {
        let (mut d, mut t) = (Detector::new(), 0);
        rodar(&mut d, 98, 1200, &mut t);
        assert!(rodar(&mut d, 30, 900, &mut t).is_none());
        assert!(d.armado());
    }
}
