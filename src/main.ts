import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const { app, env } = await createApp();

  if (env.swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('TABILO API')
      .setDescription('Gestion et supervision des demandes de service en salle.')
      .setVersion('1')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(env.port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `TABILO API sur le port ${env.port} (${env.nodeEnv})` + (env.swaggerEnabled ? ' — documentation : /docs' : ''),
  );
}

bootstrap().catch((error: Error) => {
  // Échec de démarrage : message explicite, code de sortie non nul.
  console.error(`Démarrage impossible : ${error.message}`);
  process.exit(1);
});
