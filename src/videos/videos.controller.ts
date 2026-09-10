import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseFilePipeBuilder,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { VideoService } from './video.service';

const uploadRoot = join(process.cwd(), 'data', 'uploads');
mkdirSync(uploadRoot, { recursive: true });

@Controller('api/videos')
export class VideosController {
  constructor(private readonly videoService: VideoService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('video', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadRoot),
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: {
        fileSize: Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024,
        files: 1,
      },
      fileFilter: (_req, file, cb) => {
        const allowed = new Set([
          'video/mp4',
          'video/quicktime',
          'video/webm',
          'video/x-matroska',
          'video/x-msvideo',
          'video/x-m4v',
        ]);
        if (!allowed.has(file.mimetype)) {
          cb(new BadRequestException('Unsupported video type. Use MP4, MOV, WebM, MKV or AVI.'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  upload(
    @UploadedFile(new ParseFilePipeBuilder().build({ fileIsRequired: true }))
    file: Express.Multer.File,
  ) {
    const job = this.videoService.createJob(file);
    return {
      id: job.id,
      filename: job.filename,
      status: job.status,
      progress: job.progress,
    };
  }

  @Get(':id/status')
  getJobStatus(@Param('id') id: string) {
    return this.videoService.getJob(id);
  }

  @Get(':id/playback')
  getPlayback(@Param('id') id: string) {
    const job = this.videoService.getJob(id);
    return {
      id: job.id,
      status: job.status,
      hlsUrl: job.hlsUrl,
      dashUrl: job.dashUrl,
    };
  }

  @Post(':id/cleanup')
  @HttpCode(204)
  async cleanup(@Param('id') id: string): Promise<void> {
    await this.videoService.deleteJob(id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.videoService.deleteJob(id);
  }
}
