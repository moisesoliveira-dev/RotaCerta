import { existsSync } from 'node:fs';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

/** Aceita pt e en: teste/test e producao/produção/production/prod. */
const ambiente = z.string().transform((v) => v.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
  .pipe(z.enum(['teste', 'test', 'producao', 'production', 'prod'], { message: 'AMBIENTE deve ser "teste" ou "producao".' }))
  .transform((v) => (v === 'teste' || v === 'test' ? 'teste' : 'producao') as 'teste' | 'producao');

const schema = z.object({
  /**
   * Chave única que liga o modo de TESTE ou de PRODUÇÃO: `AMBIENTE=teste` ou `AMBIENTE=producao`.
   * Teste: dados de demonstração, banco embutido sem DATABASE_URL, login com botões por perfil e limites liberados.
   * Produção: exige banco e segredo reais, sem seed, cookie seguro e sem nenhum atalho de entrada.
   * Quando definida, vale no lugar de AMBIENTE_TESTE / AMBIENTE_PRODUCAO (que continuam aceitas).
   */
  AMBIENTE: ambiente.optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Forma antiga de ligar o ambiente de TESTE. Prefira `AMBIENTE=teste`. */
  AMBIENTE_TESTE: bool,
  /** Forma antiga de ligar o ambiente de PRODUÇÃO. Prefira `AMBIENTE=producao`. */
  AMBIENTE_PRODUCAO: bool,
  PORT: z.coerce.number().int().default(3333),
  /** `pglite` (ou vazio, só no ambiente de teste) usa o Postgres embutido em `.pglite/`. */
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter ao menos 32 caracteres').optional(),
  /** Validade do token de acesso. Curto: a renovação é feita pelo cookie de sessão. */
  JWT_EXPIRES_IN: z.string().default('15m'),
  /** Dias que uma sessão sobrevive sem uso (renovada a cada acesso). */
  REFRESH_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /** `none` quando web e API ficam em domínios diferentes (exige HTTPS); `lax` no mesmo site (ex.: localhost). */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  /** Tentativas de login por minuto e por IP. */
  LOGIN_RATE_MAX: z.coerce.number().int().min(1).default(10),
  /** Dias de histórico de posições dos motoristas (dado pessoal: guardar só o necessário). */
  LOCATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Chave da API da Anthropic (Claude). Sem ela, a aba de agentes funciona para configurar, mas não conversa. */
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  /** Teto de conversas com agentes por empresa e por dia (controle de gasto). */
  AGENT_DAILY_LIMIT: z.coerce.number().int().min(1).default(300),
  /** Redis para o tempo real entre várias instâncias da API. Sem ele, o barramento é em memória (uma instância). */
  REDIS_URL: z.string().optional(),
  /** Confia nos cabeçalhos X-Forwarded-* (API atrás de proxy/balanceador). Padrão: ligado em produção. Sem isso o IP real não chega ao limite de login nem à auditoria. */
  TRUST_PROXY: z.enum(['true', 'false']).optional(),
  /** Requisições de escrita por minuto e por IP (além do limite próprio do login). */
  WRITE_RATE_MAX: z.coerce.number().int().min(1).default(300),
  /** Falhas de login seguidas, por conta, antes do bloqueio temporário. */
  LOGIN_LOCK_FAILURES: z.coerce.number().int().min(3).default(8),
  /** Minutos de bloqueio da conta após as falhas seguidas. */
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Cookie só por HTTPS. Padrão: ligado em produção. */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** Origens permitidas no CORS, separadas por vírgula. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  APP_TZ: z.string().default('America/Sao_Paulo'),
  /** Senha dos usuários criados pelo seed de desenvolvimento. */
  SEED_PASSWORD: z.string().min(8).optional(),
});

type Parsed = z.infer<typeof schema>;
export type Config = Omit<Parsed, 'DATABASE_URL' | 'JWT_SECRET'> & {
  /** Ambiente ativo, derivado de AMBIENTE (ou das chaves antigas AMBIENTE_TESTE / AMBIENTE_PRODUCAO). */
  APP_ENV: 'test' | 'production';
  DATABASE_URL: string;
  JWT_SECRET: string;
};

const TEST_JWT_SECRET = 'ambiente-de-teste-rotacerta-nao-usar-em-producao';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Lê o .env (sem sobrescrever variáveis já definidas no processo).
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  const fail = (issues: string[]): never => {
    throw new Error(`Configuração inválida:\n${issues.join('\n')}`);
  };
  if (!parsed.success) return fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));

  const c = parsed.data;
  // AMBIENTE (uma chave só) vale no lugar das duas chaves antigas
  if (c.AMBIENTE) {
    // contradição entre a chave nova e uma antiga esquecida: falha na subida, em vez de rodar no modo errado
    const oldProd = env.AMBIENTE_PRODUCAO === 'true', oldTest = env.AMBIENTE_TESTE === 'true';
    if ((c.AMBIENTE === 'teste' && oldProd) || (c.AMBIENTE === 'producao' && oldTest)) {
      return fail([`AMBIENTE=${c.AMBIENTE} contradiz ${c.AMBIENTE === 'teste' ? 'AMBIENTE_PRODUCAO=true' : 'AMBIENTE_TESTE=true'}. Use só AMBIENTE (e apague as chaves antigas).`]);
    }
    c.AMBIENTE_TESTE = c.AMBIENTE === 'teste';
    c.AMBIENTE_PRODUCAO = c.AMBIENTE === 'producao';
  }
  if (c.AMBIENTE_TESTE === c.AMBIENTE_PRODUCAO) {
    return fail(['Defina o ambiente: AMBIENTE=teste ou AMBIENTE=producao (ou, no formato antigo, exatamente um entre AMBIENTE_TESTE=true e AMBIENTE_PRODUCAO=true).']);
  }

  if (c.AMBIENTE_PRODUCAO) {
    const issues: string[] = [];
    if (!c.DATABASE_URL || c.DATABASE_URL === 'pglite') issues.push('DATABASE_URL: obrigatória em produção (Postgres real).');
    if (!c.JWT_SECRET) issues.push('JWT_SECRET: obrigatório em produção (32+ caracteres aleatórios).');
    if (issues.length) return fail(issues);
    return { ...c, NODE_ENV: 'production', APP_ENV: 'production', DATABASE_URL: c.DATABASE_URL!, JWT_SECRET: c.JWT_SECRET! };
  }

  // Teste "libera tudo": limites de tentativas e de uso muito altos, a menos que sejam definidos explicitamente
  const open = <K extends 'LOGIN_RATE_MAX' | 'WRITE_RATE_MAX' | 'AGENT_DAILY_LIMIT'>(key: K, value: number) => (env[key] === undefined || env[key] === '' ? value : c[key]);
  return {
    ...c,
    LOGIN_RATE_MAX: open('LOGIN_RATE_MAX', 1000),
    WRITE_RATE_MAX: open('WRITE_RATE_MAX', 10_000),
    AGENT_DAILY_LIMIT: open('AGENT_DAILY_LIMIT', 5000),
    LOGIN_LOCK_FAILURES: env.LOGIN_LOCK_FAILURES === undefined ? 1000 : c.LOGIN_LOCK_FAILURES,
    NODE_ENV: 'development',
    APP_ENV: 'test',
    DATABASE_URL: c.DATABASE_URL || 'pglite',
    JWT_SECRET: c.JWT_SECRET ?? TEST_JWT_SECRET,
    SEED_PASSWORD: c.SEED_PASSWORD ?? 'rotacerta123',
  };
}
