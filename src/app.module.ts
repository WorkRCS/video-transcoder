import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { VideosModule } from './videos/videos.module';

const mediaHeaders = (response: { setHeader: (name: string, value: string) => void }, filePath: string) => {
  if (filePath.endsWith('.m3u8')) response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  if (filePath.endsWith('.mpd')) response.setHeader('Content-Type', 'application/dash+xml');
  if (filePath.endsWith('.m4s')) response.setHeader('Content-Type', 'video/iso.segment');
  response.setHeader('Cache-Control', 'public, max-age=3600');
};

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'data', 'jobs'),
      serveRoot: '/media',
      serveStaticOptions: {
        setHeaders: mediaHeaders,
      },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
    }),
    VideosModule,
  ],
})
export class AppModule {}
