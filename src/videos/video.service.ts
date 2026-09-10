import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

type JobStatus = 'queued' | 'processing' | 'ready' | 'error';

interface ProbeResult {
  format?: { duration?: string };
  streams?: Array<{ width?: number; height?: number; codec_type?: string }>;
}

interface Rendition {
  name: string;
  height: number;
  bitrate: string;
  maxrate: string;
  bufsize: string;
}

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

type JobState = VideoJob & { inputPath: string };

@Injectable()
export class VideoService {
  private readonly jobs = new Map<string, JobState>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly jobsRoot = join(process.cwd(), 'data', 'jobs');
  private readonly uploadRoot = join(process.cwd(), 'data', 'uploads');
  private readonly ttlMs = Number(process.env.JOB_TTL_MINUTES ?? 30) * 60_000;
  private readonly encodingTimeoutMs = Number(process.env.ENCODING_TIMEOUT_MINUTES ?? 180) * 60_000;
  private readonly preset = process.env.FFMPEG_PRESET ?? 'veryfast';
  private readonly maxConcurrentJobs = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS ?? 1));
  private activeJobs = 0;
  private pumping = false;
  private cleanupTimer?: NodeJS.Timeout;

  constructor() {
    this.resetStorageOnBoot();
    this.cleanupTimer = setInterval(() => void this.cleanupExpiredJobs(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  createJob(file: Express.Multer.File): VideoJob {
    const id = randomUUID();
    const inputDir = join(this.jobsRoot, id, 'input');
    mkdirSync(inputDir, { recursive: true });

    const safeExt = extname(file.originalname).toLowerCase() || '.mp4';
    const inputPath = join(inputDir, `source${safeExt}`);
    const now = new Date().toISOString();

    const job: JobState = {
      id,
      filename: basename(file.originalname),
      status: 'queued',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      inputPath,
    };

    this.jobs.set(id, job);

    void fs.rename(file.path, inputPath)
      .then(() => {
        const current = this.jobs.get(id);
        if (!current) return;
        current.updatedAt = new Date().toISOString();
        this.pumpQueue();
      })
      .catch((error: unknown) => this.failJob(id, error));

    return this.publicJob(job);
  }

  getJob(id: string): VideoJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('Video job not found.');
    return this.publicJob(job);
  }

  async deleteJob(id: string): Promise<void> {
    const child = this.processes.get(id);
    if (child && !child.killed) child.kill('SIGKILL');
    this.processes.delete(id);
    this.jobs.delete(id);
    await fs.rm(join(this.jobsRoot, id), { recursive: true, force: true });
    this.pumpQueue();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const child of this.processes.values()) {
      if (!child.killed) child.kill('SIGKILL');
    }
    this.processes.clear();
  }

  private publicJob(job: JobState): VideoJob {
    const { inputPath: _inputPath, ...publicData } = job;
    return { ...publicData };
  }

  private pumpQueue(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.activeJobs < this.maxConcurrentJobs) {
        const next = [...this.jobs.values()].find(
          (job) => job.status === 'queued' && existsSync(job.inputPath),
        );
        if (!next) break;

        this.activeJobs += 1;
        void this.processJob(next.id).finally(() => {
          this.activeJobs -= 1;
          this.pumpQueue();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async processJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    try {
      job.status = 'processing';
      job.progress = 3;
      job.updatedAt = new Date().toISOString();

      const probe = await this.probe(job.inputPath);
      const video = probe.streams?.find((stream) => stream.codec_type === 'video');
      if (!video?.width || !video.height) {
        throw new Error('Input does not contain a valid video stream.');
      }

      const duration = Number(probe.format?.duration ?? 0);
      const hasAudio = probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false;
      const renditions = this.getRenditions(video.height);

      job.durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : undefined;
      job.sourceHeight = video.height;
      job.updatedAt = new Date().toISOString();

      const outputDir = join(this.jobsRoot, id, 'stream');
      await fs.rm(outputDir, { recursive: true, force: true });
      await fs.mkdir(outputDir, { recursive: true });

      await this.encodeWithFfmpeg({
        id,
        inputPath: job.inputPath,
        outputDir,
        duration,
        sourceWidth: video.width,
        sourceHeight: video.height,
        renditions,
        hasAudio,
      });

      await this.organizeOutputs(outputDir, renditions, hasAudio);
      await this.validateOutputs(outputDir, renditions, hasAudio);

      const current = this.jobs.get(id);
      if (!current) return;
      current.status = 'ready';
      current.progress = 100;
      current.hlsUrl = `/media/${id}/stream/master.m3u8`;
      current.dashUrl = `/media/${id}/stream/manifest.mpd`;
      current.updatedAt = new Date().toISOString();
      console.log(`[transcoder:${id}] ready`);
    } catch (error: unknown) {
      this.failJob(id, error);
    } finally {
      const current = this.jobs.get(id);
      if (current?.inputPath) {
        await fs.rm(current.inputPath, { force: true }).catch(() => undefined);
      }
      this.processes.delete(id);
    }
  }

  private getRenditions(sourceHeight: number): Rendition[] {
    const candidates: Rendition[] = [
      { name: '1080p', height: 1080, bitrate: '5000k', maxrate: '5350k', bufsize: '10000k' },
      { name: '720p', height: 720, bitrate: '3000k', maxrate: '3210k', bufsize: '6000k' },
      { name: '480p', height: 480, bitrate: '1500k', maxrate: '1605k', bufsize: '3000k' },
      { name: '360p', height: 360, bitrate: '800k', maxrate: '856k', bufsize: '1600k' },
    ];

    const available = candidates.filter((rendition) => sourceHeight >= rendition.height);
    if (available.length) return available;

    const height = Math.max(240, Math.floor(sourceHeight / 2) * 2);
    return [{ name: `${height}p`, height, bitrate: '800k', maxrate: '856k', bufsize: '1600k' }];
  }

  private async probe(inputPath: string): Promise<ProbeResult> {
    const executable = ffprobeStatic.path;
    if (!executable) throw new InternalServerErrorException('FFprobe binary is unavailable.');

    return new Promise((resolve, reject) => {
      execFile(
        executable,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=width,height,codec_type',
          '-of',
          'json',
          inputPath,
        ],
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
    sourceWidth: number;
    sourceHeight: number;
    renditions: Rendition[];
    hasAudio: boolean;
  }): Promise<void> {
    const executable = ffmpegPath;
    if (!executable) throw new InternalServerErrorException('FFmpeg binary is unavailable.');

    const { id, inputPath, outputDir, duration, sourceWidth, sourceHeight, renditions, hasAudio } = params;
    const sourceDar = `${sourceWidth}/${sourceHeight}`;
    const labels = renditions.map((_, index) => `[v${index}]`).join('');
    const filters = [`[0:v]split=${renditions.length}${labels}`];

    for (let index = 0; index < renditions.length; index += 1) {
      const rendition = renditions[index];
      // Do not crop to a pixel-only ratio and then force SAR=1. That creates tiny
      // DAR differences such as 608x1080 vs 404x720, which FFmpeg's DASH muxer rejects.
      // setdar preserves the original display aspect ratio across every rendition.
      filters.push(
        `[v${index}]scale=w=-2:h=${rendition.height}:force_original_aspect_ratio=decrease,setdar=${sourceDar}[out${index}]`,
      );
    }

    const args: string[] = [
      '-hide_banner',
      '-y',
      '-i',
      inputPath,
      '-filter_complex',
      filters.join(';'),
    ];

    renditions.forEach((rendition, index) => {
      args.push(
        '-map',
        `[out${index}]`,
        `-c:v:${index}`,
        'libx264',
        '-preset',
        this.preset,
        `-b:v:${index}`,
        rendition.bitrate,
        `-maxrate:v:${index}`,
        rendition.maxrate,
        `-bufsize:v:${index}`,
        rendition.bufsize,
        `-pix_fmt:v:${index}`,
        'yuv420p',
        `-g:v:${index}`,
        '48',
        `-keyint_min:v:${index}`,
        '48',
        `-sc_threshold:v:${index}`,
        '0',
      );
    });

    if (hasAudio) {
      args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    }

    args.push(
      '-f',
      'dash',
      '-dash_segment_type',
      'mp4',
      '-seg_duration',
      '4',
      '-frag_duration',
      '1',
      '-use_template',
      '1',
      '-use_timeline',
      '1',
      '-remove_at_exit',
      '0',
      '-hls_playlist',
      '1',
      '-hls_master_name',
      'master.m3u8',
      '-adaptation_sets',
      hasAudio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
      '-init_seg_name',
      'init-$RepresentationID$.m4s',
      '-media_seg_name',
      'chunk-$RepresentationID$-$Number%05d$.m4s',
      '-progress',
      'pipe:1',
      '-nostats',
      join(outputDir, 'manifest.mpd'),
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.processes.set(id, child);

      let stdoutBuffer = '';
      const stderrTail: string[] = [];
      let settled = false;
      const startedAt = Date.now();

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };

      const timeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        finish(new Error(`Encoding timed out after ${Math.round(this.encodingTimeoutMs / 60_000)} minutes.`));
      }, this.encodingTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const [key, value] = line.split('=', 2);
          if (!value || (key !== 'out_time_us' && key !== 'out_time_ms')) continue;
          const seconds = Number(value) / 1_000_000;
          const ratio = duration > 0 ? Math.min(1, seconds / duration) : 0;
          const current = this.jobs.get(id);
          if (current) {
            current.progress = Math.max(4, Math.min(98, Math.round(ratio * 95) + 3));
            current.updatedAt = new Date().toISOString();
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail.push(...chunk.toString('utf8').split(/\r?\n/).filter(Boolean));
        while (stderrTail.length > 160) stderrTail.shift();
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        finish(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (settled) return;
        if (code === 0) {
          console.log(`[transcoder:${id}] FFmpeg completed in ${Math.round((Date.now() - startedAt) / 1000)}s`);
          finish();
          return;
        }
        finish(
          new Error(
            `FFmpeg failed (${code ?? 'no-code'}${signal ? `/${signal}` : ''}): ${stderrTail.join('\n').slice(-16000)}`,
          ),
        );
      });
    });
  }

  private async organizeOutputs(outputDir: string, renditions: Rendition[], hasAudio: boolean): Promise<void> {
    const totalStreams = renditions.length + (hasAudio ? 1 : 0);

    for (let index = 0; index < totalStreams; index += 1) {
      const folder = index < renditions.length ? renditions[index].name : 'audio';
      const folderPath = join(outputDir, folder);
      await fs.mkdir(folderPath, { recursive: true });

      const initSource = join(outputDir, `init-${index}.m4s`);
      if (existsSync(initSource)) {
        await fs.rename(initSource, join(folderPath, 'init.m4s'));
      }

      const entries = await fs.readdir(outputDir);
      const prefix = `chunk-${index}-`;
      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.m4s')) continue;
        await fs.rename(join(outputDir, entry), join(folderPath, entry.replace(prefix, 'chunk-')));
      }

      const playlistPath = join(outputDir, `media_${index}.m3u8`);
      if (existsSync(playlistPath)) {
        let playlist = await fs.readFile(playlistPath, 'utf8');
        playlist = playlist.replace(new RegExp(`init-${index}\\.m4s`, 'g'), `${folder}/init.m4s`);
        playlist = playlist.replace(new RegExp(`chunk-${index}-`, 'g'), `${folder}/chunk-`);
        await fs.writeFile(playlistPath, playlist, 'utf8');
      }
    }

    const mpdPath = join(outputDir, 'manifest.mpd');
    if (existsSync(mpdPath)) {
      let mpd = await fs.readFile(mpdPath, 'utf8');
      for (let index = 0; index < totalStreams; index += 1) {
        const folder = index < renditions.length ? renditions[index].name : 'audio';
        mpd = mpd.replace(new RegExp(`(?<![\\w/])init-${index}\\.m4s`, 'g'), `${folder}/init.m4s`);
        mpd = mpd.replace(new RegExp(`(?<![\\w/])chunk-${index}-`, 'g'), `${folder}/chunk-`);
      }
      await fs.writeFile(mpdPath, mpd, 'utf8');
    }
  }

  private async validateOutputs(outputDir: string, renditions: Rendition[], hasAudio: boolean): Promise<void> {
    const manifestPath = join(outputDir, 'manifest.mpd');
    const masterPath = join(outputDir, 'master.m3u8');

    if (!existsSync(manifestPath)) {
      const files = await this.listOutputFiles(outputDir);
      throw new Error(`DASH manifest was not produced. Output files: ${files.join(', ') || 'none'}`);
    }

    if (!existsSync(masterPath)) {
      await this.createHlsMasterPlaylist(outputDir, renditions, hasAudio);
    }
    if (!existsSync(masterPath)) throw new Error('HLS master playlist was not produced.');

    for (const rendition of renditions) {
      const folder = join(outputDir, rendition.name);
      if (!existsSync(join(folder, 'init.m4s'))) {
        throw new Error(`Missing ${rendition.name} initialization segment.`);
      }
      const chunks = (await fs.readdir(folder)).filter(
        (name) => name.startsWith('chunk-') && name.endsWith('.m4s'),
      );
      if (!chunks.length) throw new Error(`Missing ${rendition.name} media segments.`);
    }

    if (hasAudio) {
      const audioFolder = join(outputDir, 'audio');
      if (!existsSync(join(audioFolder, 'init.m4s'))) throw new Error('Missing audio initialization segment.');
      const audioChunks = (await fs.readdir(audioFolder)).filter(
        (name) => name.startsWith('chunk-') && name.endsWith('.m4s'),
      );
      if (!audioChunks.length) throw new Error('Missing audio media segments.');
    }
  }

  private async createHlsMasterPlaylist(
    outputDir: string,
    renditions: Rendition[],
    hasAudio: boolean,
  ): Promise<void> {
    const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:7'];

    if (hasAudio && existsSync(join(outputDir, 'media_0.m3u8'))) {
      lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="media_4.m3u8"');
    }

    for (let index = 0; index < renditions.length; index += 1) {
      const playlist = join(outputDir, `media_${index}.m3u8`);
      if (!existsSync(playlist)) continue;
      const bandwidth = Number.parseInt(renditions[index].bitrate, 10) * 1000;
      const audio = hasAudio ? ',AUDIO="audio"' : '';
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${audio}`);
      lines.push(`media_${index}.m3u8`);
    }

    if (lines.length > 2) {
      await fs.writeFile(join(outputDir, 'master.m3u8'), `${lines.join('\n')}\n`, 'utf8');
    }
  }

  private async listOutputFiles(root: string, prefix = ''): Promise<string[]> {
    const result: string[] = [];
    const entries = await fs
      .readdir(root, { withFileTypes: true })
      .catch(() => [] as import('node:fs').Dirent[]);

    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push(...(await this.listOutputFiles(join(root, entry.name), relative)));
      } else {
        result.push(relative);
      }
    }

    return result;
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

  private resetStorageOnBoot(): void {
    rmSync(this.jobsRoot, { recursive: true, force: true });
    mkdirSync(this.jobsRoot, { recursive: true });
    rmSync(this.uploadRoot, { recursive: true, force: true });
    mkdirSync(this.uploadRoot, { recursive: true });
  }

  private async cleanupExpiredJobs(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    for (const job of [...this.jobs.values()]) {
      const age = Date.now() - Date.parse(job.updatedAt);
      const expired = (job.status === 'ready' || job.status === 'error') && age > this.ttlMs;
      const stuck = job.status === 'processing' && age > this.encodingTimeoutMs;
      const queuedTooLong = job.status === 'queued' && Date.parse(job.createdAt) < cutoff;
      if (expired || stuck || queuedTooLong) {
        await this.deleteJob(job.id);
      }
    }
  }
}
