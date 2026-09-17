const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const config = require('./config');
const state = require('./state');
const utils = require('./utils');
const sharp = require('sharp');
const playdl = require('play-dl');
const yts = require('yt-search');

let ffmpegPath = null;
try {
    ffmpegPath = require('ffmpeg-static');
} catch {
    ffmpegPath = 'ffmpeg';
}

const MAX_PLAY_DURATION_SECONDS = 15 * 60;

function getFfmpegCmd() {
    const exe = ffmpegPath === 'ffmpeg' ? 'ffmpeg' : `"${ffmpegPath}"`;
    return exe;
}

async function videoToAudio(context) {
    if (!utils.hasFfmpeg()) {
        await context.reply('Video-to-audio needs ffmpeg. Install ffmpeg, add it to PATH, then restart the bot to enable !mp3/!tomp3.');
        return;
    }

    const quoted = utils.getQuotedVideo(context);
    if (!quoted) {
        await context.reply('Reply to a video with !mp3 or !tomp3 to convert it to audio.');
        return;
    }

    try {
        const buffer = await downloadMediaMessage(quoted, 'buffer', {});
        const tempDir = path.join(config.AUTH_PATH, 'tmp');
        fs.mkdirSync(tempDir, { recursive: true });
        const base = Date.now();
        const inPath = path.join(tempDir, `in-${base}.mp4`);
        const outPath = path.join(tempDir, `out-${base}.mp3`);
        fs.writeFileSync(inPath, buffer);
        const cmd = `${getFfmpegCmd()} -y -i "${inPath.replace(/\\/g, '/')}" -vn -acodec libmp3lame -q:a 2 "${outPath.replace(/\\/g, '/')}"`;
        const { execSync } = require('child_process');
        execSync(cmd, { encoding: 'utf8', timeout: 300000 });
        const mp3 = fs.readFileSync(outPath);
        await utils.sendMedia(context.chatId, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted: context.rawMessage });
        cleanup();
    } catch (error) {
        console.error('videoToAudio failed:', error);
        await context.reply('Could not convert that video. Make sure it is a video file and ffmpeg is installed.');
    }

    function cleanup() {
        try { fs.unlinkSync(inPath); } catch {}
        try { fs.unlinkSync(outPath); } catch {}
    }
}

async function toimg(context) {
    const quoted = utils.getQuotedSticker(context);
    if (!quoted) {
        await context.reply('Reply to a sticker with !toimg to convert it to an image.');
        return;
    }

    try {
        const buffer = await downloadMediaMessage(quoted, 'buffer', {});
        const png = await sharp(buffer).png().toBuffer();
        await utils.sendMedia(context.chatId, { image: png, caption: 'Here you go.' }, { quoted: context.rawMessage });
    } catch (error) {
        console.error('toimg failed:', error);
        await context.reply('Could not convert that sticker.');
    }
}

async function toSticker(context) {
    const quoted = utils.getQuotedImage(context);
    if (!quoted) {
        await context.reply('Reply to an image with !sticker to convert it to a sticker.');
        return;
    }

    try {
        const buffer = await downloadMediaMessage(quoted, 'buffer', {});
        const webp = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp()
            .toBuffer();
        await utils.sendMedia(context.chatId, { sticker: webp }, { quoted: context.rawMessage });
    } catch (error) {
        console.error('toSticker failed:', error);
        await context.reply('Could not turn that image into a sticker.');
    }
}

async function viewonceBypass(message, context) {
    const viewOnceMedia = utils.getIncomingViewOnceMedia(message);
    if (!viewOnceMedia) return;

    try {
        const buffer = await downloadMediaMessage(viewOnceMedia, 'buffer', {});
        const inner = viewOnceMedia.message;
        const ownerJid = jidNormalizedUser(state.sock?.user?.id || '');

        if (ownerJid) {
            if (inner.stickerMessage) {
                return;
            } else if (inner.imageMessage) {
                await utils.sendMedia(ownerJid, { image: buffer, caption: inner.caption || undefined });
            } else if (inner.videoMessage) {
                await utils.sendMedia(ownerJid, { video: buffer, caption: inner.caption || undefined });
            } else if (inner.documentMessage) {
                await utils.sendMedia(ownerJid, { document: buffer, mimetype: inner.documentMessage.mimetype || 'application/octet-stream', caption: inner.caption || undefined });
            } else if (inner.audioMessage || inner.pttMessage) {
                await utils.sendMedia(ownerJid, { audio: buffer, mimetype: 'audio/ogg; codecs=opus' });
            } else {
                await utils.sendMedia(ownerJid, { document: buffer });
            }
        }
    } catch (bypassError) {
        console.error('Auto-bypass view-once failed:', bypassError);
    }
}

async function imageSearch(context, args) {
    const accessKey = config.GROQ_API_KEY ? process.env.UNSPLASH_ACCESS_KEY : null;
    if (!accessKey) {
        await context.reply('Image search is not configured. Set the UNSPLASH_ACCESS_KEY environment variable to enable it.');
        return;
    }

    const query = args.join(' ').trim();
    if (!query) {
        await context.reply('Usage: !img <search terms>');
        return;
    }

    try {
        const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&client_id=${accessKey}&per_page=5`;
        const res = await fetch(url);
        const data = await res.json();
        const items = data.results || [];
        if (!items.length) {
            await context.reply('No images found for that query.');
            return;
        }
        const it = items[0];
        const title = it.description || it.alt_description || 'Untitled';
        const imgUrl = it.urls.regular || it.urls.small || it.urls.raw;
        try {
            await utils.sendMedia(context.chatId, { image: { url: imgUrl }, caption: title }, { quoted: context.rawMessage });
        } catch (sendErr) {
            console.error('Failed to send image', imgUrl, sendErr);
            await context.reply(title + '\n' + imgUrl);
        }
    } catch (error) {
        await context.reply('Image search failed.');
    }
}

async function playSong(context, args) {
    const query = args.join(' ').trim();
    if (!query) {
        await context.reply('Usage: !play <song name>');
        return;
    }

    try {
        const searchResults = await yts(query);
        const video = (searchResults?.videos || []).find((v) => v.seconds > 0) || searchResults?.videos?.[0];

        if (!video) {
            await context.reply(`No results found for "${query}".`);
            return;
        }

        await context.reply(`🔎 Found: ${video.title} (${video.timestamp})\nTrying to get audio...`);

        let audioSent = false;

        try {
            const stream = await playdl.stream(video.url, { quality: 'highestaudio' });
            if (stream?.stream) {
                const tempDir = path.join(config.AUTH_PATH, 'tmp');
                fs.mkdirSync(tempDir, { recursive: true });
                const base = Date.now();
                const inPath = path.join(tempDir, `play-in-${base}.m4a`);
                const outPath = path.join(tempDir, `play-out-${base}.mp3`);

                await new Promise((resolve, reject) => {
                    const writeStream = fs.createWriteStream(inPath);
                    stream.stream.on('error', reject);
                    writeStream.on('error', reject);
                    writeStream.on('finish', resolve);
                    stream.stream.pipe(writeStream);
                });

                if (utils.hasFfmpeg()) {
                    const cmd = `${getFfmpegCmd()} -y -i "${inPath.replace(/\\/g, '/')}" -vn -acodec libmp3lame -q:a 2 "${outPath.replace(/\\/g, '/')}"`;
                    execSync(cmd, { encoding: 'utf8', timeout: 300000 });
                    const mp3 = fs.readFileSync(outPath);
                    await utils.sendMedia(
                        context.chatId,
                        { audio: mp3, mimetype: 'audio/mpeg', ptt: false, fileName: `${video.title}.mp3` },
                        { quoted: context.rawMessage }
                    );
                    audioSent = true;
                } else {
                    const raw = fs.readFileSync(inPath);
                    await utils.sendMedia(
                        context.chatId,
                        { audio: raw, mimetype: 'audio/mp4', ptt: false, fileName: `${video.title}.m4a` },
                        { quoted: context.rawMessage }
                    );
                    audioSent = true;
                }

                try { fs.unlinkSync(inPath); } catch {}
                try { fs.unlinkSync(outPath); } catch {}
            }
        } catch (audioError) {
            console.error('YouTube audio failed:', audioError.message);
        }

        if (!audioSent) {
            try {
                const scResults = await playdl.search(query, { source: { youtube: false, soundcloud: true } });
                const scTrack = scResults[0];
                if (scTrack) {
                    const scStream = await playdl.stream(scTrack.url, { quality: 'highestaudio' });
                    if (scStream?.stream) {
                        const tempDir = path.join(config.AUTH_PATH, 'tmp');
                        fs.mkdirSync(tempDir, { recursive: true });
                        const base = Date.now();
                        const outPath = path.join(tempDir, `play-sc-${base}.mp3`);

                        await new Promise((resolve, reject) => {
                            const writeStream = fs.createWriteStream(outPath);
                            scStream.stream.on('error', reject);
                            writeStream.on('error', reject);
                            writeStream.on('finish', resolve);
                            scStream.stream.pipe(writeStream);
                        });

                        const mp3 = fs.readFileSync(outPath);
                        await utils.sendMedia(
                            context.chatId,
                            { audio: mp3, mimetype: 'audio/mpeg', ptt: false, fileName: `${scTrack.title || video.title}.mp3` },
                            { quoted: context.rawMessage }
                        );
                        audioSent = true;

                        try { fs.unlinkSync(outPath); } catch {}
                    }
                }
            } catch (scError) {
                console.error('SoundCloud audio failed:', scError.message);
            }
        }

        if (!audioSent) {
            await context.reply(
                `🎵 ${video.title}\n` +
                `👤 ${video.author?.name || 'Unknown'}\n` +
                `⏱️ ${video.timestamp}\n\n` +
                `▶️ ${video.url}\n\n` +
                `Audio is unavailable right now. Open the link to listen.`
            );
        }
    } catch (error) {
        console.error('playSong failed:', error);
        await context.reply('Could not fetch that song right now. Try a different search term or try again later.');
    }
}

module.exports = {
    videoToAudio,
    toimg,
    toSticker,
    viewonceBypass,
    imageSearch,
    playSong
};
