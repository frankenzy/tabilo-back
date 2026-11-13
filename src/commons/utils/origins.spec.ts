import { isAllowedOrigin } from './origins';

describe('origines autorisées (CORS et temps réel)', () => {
  const dev = { corsOrigins: ['http://localhost:3004'], nodeEnv: 'development' as const };
  const prod = { corsOrigins: ['https://app.tabilo.ci'], nodeEnv: 'production' as const };

  it('accepte toujours la liste configurée et les requêtes sans origine', () => {
    expect(isAllowedOrigin('http://localhost:3004', dev)).toBe(true);
    expect(isAllowedOrigin('https://app.tabilo.ci', prod)).toBe(true);
    expect(isAllowedOrigin(undefined, prod)).toBe(true);
  });

  it('hors production, accepte les adresses locales et du réseau local (tests sur téléphone)', () => {
    for (const origin of ['http://127.0.0.1:3004', 'http://192.168.12.119:3004', 'http://10.0.0.5:3004', 'http://172.20.1.2:3004']) {
      expect(isAllowedOrigin(origin, dev)).toBe(true);
    }
    expect(isAllowedOrigin('http://172.32.0.1:3004', dev)).toBe(false);
    expect(isAllowedOrigin('https://site-malveillant.com', dev)).toBe(false);
  });

  it('en production, seule la liste fait foi', () => {
    expect(isAllowedOrigin('http://192.168.12.119:3004', prod)).toBe(false);
    expect(isAllowedOrigin('http://localhost:3004', prod)).toBe(false);
  });
});
