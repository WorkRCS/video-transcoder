# FastStream Video

A simple guest video transcoder built with NestJS, Tailwind CSS, and FFmpeg.

## What it does

- No login, signup, accounts, or user history.
- Upload one video from the browser.
- Shows live upload progress, then server-side encoding progress.
- Generates MPEG-DASH (`manifest.mpd`) and HLS (`master.m3u8`) from the same FFmpeg DASH/CMAF encode.
- Plays HLS in the browser with hls.js and DASH with dash.js.
- Provides copyable HLS/DASH URLs.
- A page refresh clears the browser UI. The `pagehide` handler also asks the server to remove the current guest job; automatic TTL cleanup is the fallback.
- Runtime files are temporary and are deleted on server restart or after the configured TTL.

## Requirements

- Node.js 20+
- npm
- A machine/host where the bundled `ffmpeg-static` and `ffprobe-static` binaries can run.

## Run locally

```bash
git clone https://github.com/WorkRCS/video-transcoder.git
cd video-transcoder
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

For development:

```bash
npm install
npm run start:dev
```

`start:dev` builds the Tailwind stylesheet first, then starts Nest in watch mode.

## API

### Upload

`POST /api/videos/upload`

Form field:

```text
video=<file>
```

Response:

```json
{
  "id": "job-id",
  "filename": "input.mp4",
  "status": "queued",
  "progress": 0
}
```

### Status

`GET /api/videos/:id/status`

Returns the current job state, progress, and final stream URLs when ready.

### Playback URLs

`GET /api/videos/:id/playback`

Returns HLS and DASH URLs when the job is ready.

### Cleanup

`POST /api/videos/:id/cleanup` or `DELETE /api/videos/:id`

Removes the temporary job files immediately.

## Runtime configuration

Copy `.env.example` to `.env`:

```text
PORT=3000
MAX_UPLOAD_MB=1024
JOB_TTL_MINUTES=30
ENCODING_TIMEOUT_MINUTES=180
FFMPEG_PRESET=veryfast
```

`FFMPEG_PRESET=veryfast` is the default speed-oriented preset. Use a slower preset for better compression efficiency when encoding speed is less important.

## Output layout

A job is stored temporarily under:

```text
data/jobs/<job-id>/stream/
  master.m3u8
  manifest.mpd
  init-*.m4s
  chunk-*.m4s
```

The browser receives URLs like:

```text
/media/<job-id>/stream/master.m3u8
/media/<job-id>/stream/manifest.mpd
```

The application intentionally does not persist user accounts or permanent video history.

## Production direction

This first version is intentionally simple for local testing. For high-volume production, move the temporary files to object storage, put a durable queue in front of separate FFmpeg workers, and put a CDN with HTTP/3 in front of the media. The API contract can stay the same.
