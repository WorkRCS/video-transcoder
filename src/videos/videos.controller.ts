import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  ParseFilePipeBuilder,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Request } from 'express';
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
  async upload(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSize(Number(process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024)
        .build({ fileIsRequired: true }),
    )
    file: Express.Multer.File,
    _request: Request,
  ) {
    const job = this.videoService.createJob(file);
    return {
      id: job.id,
      filename: job.filename,
      status: job.status,
      progress: job.progress,
    };
  }

  @Get(':id')
  getStatus(@UploadedFile() _unused: Express.Multer.File) {
    // Kept as a thin route method below by reading the id from the request parameter.
    void _unused;
    throw new BadRequestException('Use /api/videos/:id/status.');
  }

  @Get(':id/status')
  getJobStatus(@UploadedFile() _unused: Express.Multer.File, request: Request) {
    void _unused;
    const id = request.params.id;
    return this.videoService.getJob(id);
  }

  @Get(':id/playback')
  getPlayback(@UploadedFile() _unused: Express.Multer.File, request: Request) {
    void _unused;
    const job = this.videoService.getJob(request.params.id);
    return {
      id: job.id,
      status: job.status,
      hlsUrl: job.hlsUrl,
      dashUrl: job.dashUrl,
    };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@UploadedFile() _unused: Express.Multer.File, request: Request): Promise<void> {
    void _unused;
    await this.videoService.deleteJob(request.params.id);
  }
}
