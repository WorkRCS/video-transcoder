import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

type JobStatus = 'queued' | 'processing' | 'ready' | 'error';

export interface VideoJob {
  id: string;
  filename: string;
  status: JobStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  durationSeconds?: number;
  sourceHeight?: number;
  hlsUrl?: string;
  dashUrl?: string;
  error?: string;
}

interface ProbeResult {
  format?: { duration?: string };
  streams?: Array<{ width?: number; height?: number; codec_type?: string }>;
}

interface Rendition {
  height: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
}

@Injectable()
export class VideoService {
  private readonly jobs = new Map<string, VideoJob>();
  private readonly jobsRoot = join(process.cwd(), 'data', 'jobs');
  private readonly uploadRoot = join(process.cwd(), 'data', 'uploads');
  private readonly ttlMs = Number(process.env.JOB_TTL_MINUTES ?? 30) * 60_000;
  private readonly encodingTimeoutMs = Number(process.env.ENCODING_TIMEOUT_MINUTES ?? 180) * 60_000;
  private readonly preset = process.env.FFMPEG_PRESET ?? 'veryfast';

  constructor() {
    this.ensureDirectories();
    void this.resetStorageOnBoot();
    const timer = setInterval(() => void this.cleanupExpiredJobs(), 5 * 60_000);
    timer.unref();
  }

  createJob(file: Express.Multer.File): VideoJob {
    const id = randomUUID();
    const jobDir = join(this.jobsRoot, id);
    const inputDir = join(jobDir, 'input');
    mkdirSync(inputDir, { recursive: true });

    const safeExt = extname(file.originalname).toLowerCase() || '.mp4';
    const inputPath = join(inputDir, `source${safeExt}`);

    const job: VideoJob = {
      id,
      filename: basename(file.originalname),
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(id, job);
    void fs.rename(file.path, inputPath)
      .then(() => this.processJob(id, inputPath))
      .catch((error: unknown) => this.failJob(id, error));

    return { ...job };
  }

  getJob(id: string): VideoJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('Video job not found.');
    return { ...job };
  }

  async deleteJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    await fs.rm(join(this.jobsRoot, id), { recursive: true, force: true });
  }

  private async processJob(id: string, inputPath: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    try {
      job.status = 'processing';
      job.progress = 3;
      job.updatedAt = new Date().toISOString();

      const probe = await this.probe(inputPath);
      const duration = Number(probe.format?.duration ?? 0);
      const sourceHeight = probe.streams?.find((stream) => stream.codec_type === 'video')?.height ?? 720;
      const hasAudio = probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false;

      job.durationSeconds = Number.isFinite(duration) ? duration : undefined;
      job.sourceHeight = sourceHeight;
      job.updatedAt = new Date().toISOString();

      const outputDir = join(this.jobsRoot, id, 'stream');
      await fs.mkdir(outputDir, { recursive: true });

      const renditions = this.getRenditions(sourceHeight);
      await this.encodeWithFfmpeg({
        id,
        inputPath,
        outputDir,
        duration,
        renditions,
        hasAudio,
      });

      const masterPath = join(outputDir, 'master.m3u8');
      const dashPath = join(outputDir, 'manifest.mpd');
      if (!existsSync(masterPath) || !existsSync(dashPath)) {
        throw new Error('FFmpeg finished without producing both HLS and DASH manifests.');
      }

      job.status = 'ready';
      job.progress = 100;
      job.hlsUrl = `/media/${id}/stream/master.m3u8`;
      job.dashUrl = `/media/${id}/stream/manifest.mpd`;
      job.updatedAt = new Date().toISOString();
    } catch (error: unknown) {
      this.failJob(id, error);
    }
  }

  private getRenditions(sourceHeight: number): Rendition[] {
    const candidates: Rendition[] = [
      { height: 1080, bitrate: '5000k', maxrate: '5350k', bufsize: '10000k' },
      { height: 720, bitrate: '3000k', maxrate: '3210k', bufsize: '6000k' },
      { height: 480, bitrate: '1500k', maxrate: '1605k', bufsize: '3000k' },
      { height: 360, bitrate: '800k', maxrate: '856k', bufsize: '1600k' },
    ];

    const available = candidates.filter((r) => sourceHeight >= r.height);
    return available.length > 0
      ? available
      : [{ height: Math.max(240, Math.floor(sourceHeight / 2) * 2), bitrate: '800k', maxrate: '856k', bufsize: '1600k' }];
  }

  private async probe(inputPath: string): Promise<ProbeResult> {
    const executable = ffprobeStatic.path;
    if (!executable) throw new InternalServerErrorException('FFprobe binary is unavailable.');

    return new Promise<ProbeResult>((resolve, reject) => {
      execFile(
        executable,
        ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', inputPath],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Unable to inspect video: ${stderr || error.message}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout) as ProbeResult);
          } catch {
            reject(new Error('FFprobe returned invalid metadata.'));
          }
        },
      );
    });
  }

  private async encodeWithFfmpeg(params: {
    id: string;
    inputPath: string;
    outputDir: string;
    duration: number;
    renditions: Rendition[];
    hasAudio: boolean;
  }): Promise<void> {
    const executable = ffmpegPath;
    if (!executable) throw new InternalServerErrorException('FFmpeg binary is unavailable.');

    const { id, inputPath, outputDir, duration, renditions, hasAudio } = params;
    const filterParts: string[] = [];
    const splitLabels = renditions.map((_, index) => `[v${index}]`).join('');
    const outputLabels = renditions.map((_, index) => `[out${index}]`).join('');
    filterParts.push(`[0:v]split=${renditions.length}${splitLabels};`);
    renditions.forEach((rendition, index) => {
      filterParts.push(
        `[v${index}]scale=w=-2:h=${rendition.height}:force_original_aspect_ratio=decrease,setsar=1[out${index}]`,
      );
      if (index !== renditions.length - 1) filterParts.push(';');
    });

    const args: string[] = ['-hide_banner', '-y', '-i', inputPath, '-filter_complex', filterParts.join('')];
    renditions.forEach((rendition, index) => {
      args.push('-map', outputLabels.split('[').filter(Boolean)[index].replace(']', '').replace(/^/, '['));
      args.push(
        `-c:v:${index}`, 'libx264',
        `-preset`, this.preset,
        `-b:v:${index}`, rendition.bitrate,
        `-maxrate:v:${index}`, rendition.maxrate,
        `-bufsize:v:${index}`, rendition.bufsize,
        `-pix_fmt:v:${index}`, 'yuv420p',
        `-g:v:${index}`, '48',
        `-keyint_min:v:${index}`, '48',
        `-sc_threshold:v:${index}`, '0',
      );
    });

    if (hasAudio) {
      args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    }

    args.push(
      '-f', 'dash',
      '-seg_duration', '4',
      '-frag_duration', '1',
      '-use_template', '1',
      '-use_timeline', '1',
      '-streaming', '1',
      '-remove_at_exit', '0',
      '-hls_playlist', '1',
      '-hls_master_name', 'master.m3u8',
      '-adaptation_sets', hasAudio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
      '-init_seg_name', 'init-$RepresentationID$.m4s',
      '-media_seg_name', 'chunk-$RepresentationID$-$Number%05d$.m4s',
      '-progress', 'pipe:1',
      '-nostats',
      join(outputDir, 'manifest.mpd'),
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuffer = '';
      const stderrTail: string[] = [];
      let finished = false;
      const startedAt = Date.now();

      const finishError = (error: Error) => {
        if (finished) return;
        finished = true;
        reject(error);
      };

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finishError(new Error('Encoding timed out.'));
      }, this.encodingTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const [key, value] = line.split('=', 2);
          if (!value) continue;
          if (key === 'out_time_us' || key === 'out_time_ms') {
            const raw = Number(value);
            const seconds = key === 'out_time_us' ? raw / 1_000_000 : raw / 1_000_000;
            const ratio = duration > 0 ? Math.min(1, seconds / duration) : 0;
            const currentJob = this.jobs.get(id);
            if (currentJob) {
              currentJob.progress = Math.max(4, Math.min(98, Math.round(ratio * 95) + 3));
              currentJob.updatedAt = new Date().toISOString();
            }
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean);
        stderrTail.push(...lines);
        while (stderrTail.length > 25) stderrTail.shift();
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        finishError(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (finished) return;
        if (code === 0) {
          finished = true;
          const currentJob = this.jobs.get(id);
          if (currentJob) currentJob.progress = 98;
          console.log(`[transcoder:${id}] completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
          resolve();
          return;
        }
        finishError(new Error(`FFmpeg failed (${code ?? 'no-code'}${signal ? `/${signal}` : ''}): ${stderrTail.join('\n').slice(-4000)}`));
      });
    });
  }

  private failJob(id: string, error: unknown): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'error';
    job.progress = 0;
    job.error = error instanceof Error ? error.message : 'Unexpected transcoding error.';
    job.updatedAt = new Date().toISOString();
    console.error(`[transcoder:${id}] ${job.error}`);
  }

  private ensureDirectories(): void {
    mkdirSync(this.jobsRoot, { recursive: true });
    mkdirSync(this.uploadRoot, { recursive: true });
  }

  private async resetStorageOnBoot(): Promise<void> {
    await fs.rm(this.jobsRoot, { recursive: true, force: true });
    await fs.mkdir(this.jobsRoot, { recursive: true });
    await fs.rm(this.uploadRoot, { recursive: true, force: true });
    await fs.mkdir(this.uploadRoot, { recursive: true });
  }

  private async cleanupExpiredJobs(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    for (const job of this.jobs.values()) {
      const age = Date.now() - Date.parse(job.updatedAt);
      const expired = (job.status === 'ready' || job.status === 'error') && age > this.ttlMs;
      const stuck = job.status === 'processing' && age > this.encodingTimeoutMs;
      if (expired || stuck || Date.parse(job.createdAt) < cutoff && job.status === 'queued') {
        await this.deleteJob(job.id);
      }
    }
  }
}
