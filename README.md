# ritmo

Agenda de rotinas e foco para o desktop (Windows). Leve: feito com [Tauri v2](https://v2.tauri.app), usa o WebView2 do próprio Windows.

O dia é organizado em **blocos ancorados** (acordar, trabalho, almoço, noite). Cada bloco pode ter um **roteiro guiado**, uma **versão mínima** para dias ruins, ou abrir um **bloco de foco**.

## O que faz

- **Hoje**: linha do tempo do dia com o bloco atual em destaque, tarefas com até 3 prioridades (★).
  Uma tarefa não feita passa sozinha para o dia seguinte. Depois de 3 adiamentos, o app pede uma decisão: focar agora, quebrar em partes ou descartar.
- **Foco**: Pomodoro (25/5 ou 50/10) que só começa com *uma tarefa* e *o primeiro passo concreto* escritos.
  Sino de início e fim, ruído marrom ou chuva gerados no próprio app, ou um vídeo sorteado da sua lista do YouTube tocando num canto.
  Distrações são anotadas sem sair do bloco. No fim, uma linha registra o que saiu.
- **Roteiros guiados**: passos com texto, timer, campos de escrita, contador e lista do dia, definidos no config.
- **Semana**: hábitos contados como *x de 7*, não como sequência (o mínimo conta). Horas de foco por contexto contra a meta, lazer que aconteceu.
- **Fechar o dia**: checklist da noite, revisão, pendências, triagem das distrações e as 3 prioridades de amanhã.
- **Widget**: janela pequena sempre por cima, com o timer e os blocos atual e seguinte. Pode ser arrastada.
- **Bandeja e inicialização**: fechar a janela só esconde o app. Opcionalmente abre com o Windows, mostrando só o widget.
- **Notificações nativas** no fim de cada bloco de foco e no início de cada bloco com roteiro.

## Instalar

Baixe o instalador `.exe` em [Releases](../../releases), ou compile (abaixo).

## Compilar

Requisitos: [Rust](https://rustup.rs), Microsoft C++ Build Tools, Node 18+.

```bash
npm install
npm run dev      # desenvolvimento
npm run build    # instalador em src-tauri/target/release/bundle/nsis/
```

## Configurar a rotina

A rotina fica em `%APPDATA%\ritmo\config.json`, criado na primeira execução a partir de [`src/config.exemplo.json`](src/config.exemplo.json).
Edite e use **Ajustes → Recarregar config**, ou **Ajustes → Importar config…**. Os dados (tarefas, hábitos, sessões) ficam em `estado.json`, na mesma pasta.

| Chave | O que é |
|---|---|
| `contextos` | Áreas da vida, com `nome`, `cor` e, opcionalmente, `metaHoras` (foco por semana) ou `metaBlocos` (lazer por semana). |
| `rotinas` | Roteiros guiados: `nome`, `minimo` e `passos`. |
| `habitos` | Rotinas que aparecem na grade da semana. |
| `semana` | De `"0"` (domingo) a `"6"` (sábado): blocos `{ini, fim, titulo, ctx}` com `rotina`, `foco: true` ou `lazer: true`. |
| `presets` | Durações do foco: `[foco, pausa, pausa longa a cada 4]`, em minutos. |
| `checklistNoite`, `fechamento.rotina` | Itens e rotina da aba Fechar o dia. |

Tipos de passo (`t`): `texto` (`titulo`, `corpo`), `timer` (`min`, `dica`), `campo` (`rotulo`; com `tarefaEmDias`, a resposta vira uma tarefa ★), `contador` (`rotulo`, `alvo`; a rotina só fica completa ao bater o alvo), `lista_do_dia` (`porDia` com 7 nomes, `listas`), `copiar` (copia os campos como texto).

## Licença

MIT
