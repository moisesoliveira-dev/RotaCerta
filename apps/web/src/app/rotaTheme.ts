import { defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

/**
 * Tema "Rota": a identidade azul da tela de entrada (azul-marinho, azul de ação e fundos azulados) sobre a estrutura do
 * Astryx. Cada token é [claro, escuro]; o que não é listado vem do tema Neutro.
 */
export const rotaTheme = defineTheme({
  name: 'rota',
  extends: neutralTheme,
  tokens: {
    '--color-accent': ['#1b4fd8', '#7fa8ff'],
    '--color-background-body': ['#edf2fb', '#07122a'],
    // a área de conteúdo é levemente azulada e os cartões brancos: assim cada bloco se destaca como um contêiner
    '--color-background-surface': ['#f6f8fd', '#0b1733'],
    '--color-background-card': ['#ffffff', '#0e1c3d'],
    '--color-background-muted': ['#e1e9f7', '#162850'],
    '--color-background-inverted': ['#081735', '#e7eefc'],
    '--color-text-primary': ['#0a1a3c', '#e7eefc'],
    '--color-text-secondary': ['#56658b', '#94a6cc'],
    '--color-border': ['#c3d0e8', '#2a3f73'],
    '--color-info': ['#1b4fd8', '#7fa8ff'],
    '--color-text-info': ['#1b4fd8', '#7fa8ff'],
  },
});
