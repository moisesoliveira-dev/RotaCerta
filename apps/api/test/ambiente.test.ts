import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { closeTestDbs, createTestApp } from './helpers';

describe('AMBIENTE (teste ou produção)', () => {
  const prod = { DATABASE_URL: 'postgres://u:p@h/db', JWT_SECRET: 'x'.repeat(40) };

  it('AMBIENTE=teste liga o modo de teste e libera os limites', () => {
    const c = loadConfig({ AMBIENTE: 'teste' });
    expect(c.APP_ENV).toBe('test');
    expect(c.DATABASE_URL).toBe('pglite');
    expect(c.LOGIN_RATE_MAX).toBe(1000);
    expect(c.LOGIN_LOCK_FAILURES).toBe(1000);
    // o que for definido explicitamente continua valendo
    expect(loadConfig({ AMBIENTE: 'teste', LOGIN_RATE_MAX: '5' }).LOGIN_RATE_MAX).toBe(5);
  });

  it('AMBIENTE=producao exige banco e segredo e mantém os limites', () => {
    expect(() => loadConfig({ AMBIENTE: 'producao' })).toThrow(/DATABASE_URL/);
    const c = loadConfig({ AMBIENTE: 'producao', ...prod });
    expect(c.APP_ENV).toBe('production');
    expect(c.LOGIN_RATE_MAX).toBe(10);
    expect(c.LOGIN_LOCK_FAILURES).toBe(8);
  });

  it('aceita variações (production, Produção, test) e recusa valores desconhecidos', () => {
    expect(loadConfig({ AMBIENTE: 'Produção', ...prod }).APP_ENV).toBe('production');
    expect(loadConfig({ AMBIENTE: 'production', ...prod }).APP_ENV).toBe('production');
    expect(loadConfig({ AMBIENTE: 'test' }).APP_ENV).toBe('test');
    expect(() => loadConfig({ AMBIENTE: 'homologacao' })).toThrow(/AMBIENTE/);
  });

  it('as duas chaves antigas continuam funcionando sozinhas; contradizer AMBIENTE impede a subida', () => {
    expect(() => loadConfig({ AMBIENTE: 'producao', AMBIENTE_TESTE: 'true', ...prod })).toThrow(/contradiz/);
    expect(() => loadConfig({ AMBIENTE: 'teste', AMBIENTE_PRODUCAO: 'true' })).toThrow(/contradiz/);
    // a mesma coisa dita das duas formas não é contradição
    expect(loadConfig({ AMBIENTE: 'producao', AMBIENTE_PRODUCAO: 'true', ...prod }).APP_ENV).toBe('production');
    expect(loadConfig({ AMBIENTE_TESTE: 'true', AMBIENTE_PRODUCAO: 'false' }).APP_ENV).toBe('test');
    expect(() => loadConfig({})).toThrow(/AMBIENTE=teste ou AMBIENTE=producao/);
  });
});

describe('entrada rápida por perfil (só no teste)', () => {
  let test: FastifyInstance;
  let production: FastifyInstance;
  beforeAll(async () => {
    ({ app: test } = await createTestApp());
    ({ app: production } = await createTestApp({ config: { APP_ENV: 'production', AMBIENTE_TESTE: false, AMBIENTE_PRODUCAO: true } }));
  });
  afterAll(async () => { await test.close(); await production.close(); await closeTestDbs(); });

  it('lista os perfis e entra como cada um, sem senha', async () => {
    const env = (await test.inject({ method: 'GET', url: '/api/env' })).json();
    expect(env.environment).toBe('teste');
    expect(env.quickLogin.map((p: { role: string }) => p.role)).toEqual(['gestao', 'atendente', 'expedicao', 'motorista', 'plataforma']);
    for (const { role } of env.quickLogin) {
      const res = await test.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { role } });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe(role);
      expect(res.json().mustChangePassword).toBe(false);
      expect(String(res.headers['set-cookie'])).toContain('rc_refresh=');
      const me = await test.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${res.json().token}` } });
      expect(me.statusCode).toBe(200);
    }
    expect((await test.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { role: 'admin' } })).statusCode).toBe(400);
  });

  it('entra sem senha também pelo e-mail (completo ou só o início) e recusa quem não existe', async () => {
    for (const email of ['atendente@rotacerta.local', 'atendente', ' EXPEDICAO ']) {
      const res = await test.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { email } });
      expect(res.statusCode, email).toBe(200);
    }
    const ok = await test.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { email: 'atendente' } });
    expect(ok.json().user.role).toBe('atendente');
    const missing = await test.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { email: 'ninguem' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toContain('ninguem');
  });

  it('em produção não existe: o ambiente diz "producao", sem perfis, e a entrada rápida dá 404', async () => {
    const env = (await production.inject({ method: 'GET', url: '/api/env' })).json();
    expect(env).toEqual({ environment: 'producao', quickLogin: [] });
    const res = await production.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { role: 'gestao' } });
    expect(res.statusCode).toBe(404);
    // nem pelo e-mail, nem com a senha em branco no login normal
    expect((await production.inject({ method: 'POST', url: '/api/auth/quick-login', payload: { email: 'gestao@rotacerta.local' } })).statusCode).toBe(404);
    expect((await production.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'gestao@rotacerta.local', password: '' } })).statusCode).not.toBe(200);
    // e o login normal continua exigindo a senha certa
    expect((await production.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'gestao@rotacerta.local', password: 'errada' } })).statusCode).toBe(401);
  });
});
