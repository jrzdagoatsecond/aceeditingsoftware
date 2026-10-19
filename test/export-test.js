// Generates sample clips, then exports them in every format and with every effect,
// checking each result with ffprobe.
// Usage: node test/export-test.js [path-to-ffmpeg] [path-to-ffprobe]
const { execFileSync } = require('child_process');
const path = require('path'); const os = require('os'); const fs = require('fs');
const { runExport, FORMATS } = require('../src/exporter');

const ffmpeg = process.argv[2] || (() => { try { return require('ffmpeg-static'); } catch (e) { return 'ffmpeg'; } })();
const ffprobe = process.argv[3] || 'ffprobe';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-test-'));
const sh = (...a) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...a]);

const a = path.join(dir, 'a.mp4'), b = path.join(dir, 'b.mp4'), img = path.join(dir, 'c.png');
sh('-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-pix_fmt', 'yuv420p', '-shortest', a);
sh('-f', 'lavfi', '-i', 'smptebars=size=640x480:rate=25', '-t', '3', '-pix_fmt', 'yuv420p', b);   // no audio, 4:3
sh('-f', 'lavfi', '-i', 'color=c=white:size=400x400', '-frames:v', '1', img);

const fx = (o) => Object.assign({ fadeIn: 0, fadeOut: 0, blur: 0, speed: 1, volume: 100, muted: false,
  brightness: 0, contrast: 0, saturation: 0, sharpen: 0, bw: false, fit: 'contain',
  reverse: false, interp: 'nearest', pitch: true, blurType: 'gaussian', blurAmt: 0,
  hue: 0, vignette: 0, grain: 0, flipH: false, flipV: false }, o);

const mix = [
  { path: a, type: 'video', hasAudio: true,  in: 0.5, out: 3.5, fx: fx({ fadeIn: 0.5, fadeOut: 0.5, blur: 60, contrast: 10, saturation: 15, sharpen: 30 }) },
  { path: b, type: 'video', hasAudio: false, in: 0,   out: 2,   fx: fx({ speed: 2, bw: true, fit: 'cover', interp: 'blend' }) },
  { path: a, type: 'video', hasAudio: true,  in: 1,   out: 2,   fx: fx({ speed: 0.5, interp: 'blend', volume: 50, brightness: 10 }) },
  { path: img, type: 'image', hasAudio: false, in: 0, out: 1.5, fx: fx({ fadeIn: 0.3, fadeOut: 0.3 }) }
];
const mixLen = 3 + 1 + 2 + 1.5;

const jobs = [];
const settings = (format, extra) => Object.assign({ w: 640, h: 360, fps: 30, quality: 'draft', format }, extra);

// 1) every format with the mixed timeline
Object.keys(FORMATS).forEach((f) => jobs.push({ name: 'format ' + f, clips: mix, settings: settings(f), len: mixLen, kind: FORMATS[f].kind, ext: FORMATS[f].ext }));
// 2) vertical size
jobs.push({ name: 'vertical 9:16', clips: mix, settings: settings('mp4', { w: 360, h: 640 }), len: mixLen, kind: 'video', ext: 'mp4' });

// 3) each effect on its own
const one = (name, o, extra = {}) => jobs.push({ name, clips: [{ path: a, type: 'video', hasAudio: true, in: 0, out: extra.src || 2, fx: fx(o) }],
  settings: settings('mp4'), len: (extra.src || 2) / (o.speed || 1), kind: 'video', ext: 'mp4' });
['gaussian', 'box', 'horizontal', 'vertical', 'zoom'].forEach((t) => one('blur ' + t, { blurType: t, blurAmt: 60 }));
one('vignette', { vignette: 70 }); one('grain', { grain: 50 }); one('flip both', { flipH: true, flipV: true });
one('hue shift', { hue: 90 }); one('reverse', { reverse: true });
one('slow nearest', { speed: 0.4 }); one('slow blend', { speed: 0.4, interp: 'blend' }); one('slow optical flow', { speed: 0.5, interp: 'optical' });
one('fast blend', { speed: 3, interp: 'blend' }, { src: 3 }); one('pitch change', { speed: 1.5, pitch: false });
one('very slow', { speed: 0.1, interp: 'blend' }, { src: 1 });
one('everything at once', { blurType: 'zoom', blurAmt: 40, blur: 30, vignette: 40, grain: 20, hue: -30, flipH: true, speed: 0.5, interp: 'blend', fadeIn: 0.3, fadeOut: 0.3, bw: false, reverse: true });

(async () => {
  let failed = 0;
  for (const j of jobs) {
    const out = path.join(dir, j.name.replace(/\W+/g, '_') + '.' + j.ext);
    const r = await runExport({ ffmpegPath: ffmpeg, clips: j.clips, settings: j.settings, outPath: out }).promise;
    if (!r.ok) { failed++; console.log('FAIL', j.name, '->', r.error); continue; }
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', out]).toString());
    const types = info.streams.map((s) => s.codec_type);
    const dur = parseFloat(info.format.duration);
    const okTypes = j.kind === 'audio' ? (types.length === 1 && types[0] === 'audio')
      : j.kind === 'gif' ? (types.length === 1 && types[0] === 'video')
      : (types.includes('video') && types.includes('audio'));
    const okDur = Math.abs(dur - j.len) < 0.35;
    const codecs = info.streams.map((s) => s.codec_name).join('+');
    console.log((okTypes && okDur ? 'ok  ' : 'BAD ') + j.name.padEnd(20), codecs.padEnd(24), 'len', dur.toFixed(2), '(want', j.len.toFixed(2) + ')');
    if (!(okTypes && okDur)) failed++;
  }
  console.log(failed ? `\n${failed} FAILED` : `\nALL ${jobs.length} EXPORT TESTS PASSED`);
  process.exit(failed ? 1 : 0);
})();
