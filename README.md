# Podcast DualSub

Bilingual transcripts for the iOS Podcasts app, as a Quantumult X script.

The script intercepts the TTML transcript the Podcasts app downloads and adds a translation for every sentence, so the app's own Transcript view shows both languages. Translation uses Google by default; no API key needed.

```
This is Planet Money from NPR.
这里是来自美国国家公共广播电台的《金钱星球》节目。
Raise your hand if you have a friend like this.
如果你有这样的朋友，请举手。
```

## Install (Quantumult X)

1. Add a rewrite resource:

   ```
   https://raw.githubusercontent.com/illusion77/podcast-dualsub/main/podcast-dualsub.snippet
   ```

   Or paste this into your config:

   ```
   [rewrite_local]
   ^https:\/\/podcasts\.itunes\.apple\.com\/itunes-assets\/.+\/transcript_\d+\.ttml url script-response-body https://raw.githubusercontent.com/illusion77/podcast-dualsub/main/podcast-dualsub.js

   [mitm]
   hostname = podcasts.itunes.apple.com
   ```

2. Make sure the MitM certificate is installed and trusted (Settings → General → About → Certificate Trust Settings), and that Rewrite and MitM are both on.
3. Open an episode whose transcript you have **not opened before** and tap Transcript. For episodes you already played, see [below](#episodes-you-played-before-installing-the-script).

The same script runs on Surge / Loon; see the comment at the top of `podcast-dualsub.js` for the config line. On Surge, keep `max-size=0`: transcripts range from a few hundred KB to several MB.

## Options

Append them to the script URL (`podcast-dualsub.js#tl=zh-TW&mode=inline`), pass them as `argument` on Surge / Loon, or store JSON under the persistent key `podcast_dualsub`.

| Option | Default | Description |
| --- | --- | --- |
| `tl` | `zh-CN` | Target language: `zh-TW`, `ja`, `ko`, or any other Google language code |
| `mode` | `stack` | `stack`: translation on its own line under each sentence. `inline`: translation right after each sentence, paragraphs kept. `only`: translation only |
| `timing` | `sentence` | `sentence`: the translation spans the whole sentence, and tapping it plays from the start of the sentence. `end`: the translation sits at the sentence end and never overlaps the original word timings (switch to this if word highlighting misbehaves during playback) |
| `timeout` | `20` | Total translation budget in seconds; whatever is translated by then is still inserted |
| `concurrency` | `4` | Parallel translation requests |
| `notify` | `error` | `error`: notify on failure only. `all`: every episode. `none`: never |

## Episodes you played before installing the script

The app downloads each transcript once, caches it locally (`Library/Cache/Assets/TTML`), and never checks the server again. The script only sees transcripts that are actually downloaded, so episodes you had already opened stay English-only. The app also prefetches transcripts for new episodes in your library in the background; if Quantumult X isn't running at that moment, those get cached in English too.

To re-fetch one of them with the script active:

1. If the episode isn't downloaded, download it first (long-press → Download Episode).
2. Long-press → **Remove Download**. This also deletes the cached transcript.
3. Force-quit Podcasts from the app switcher (it keeps opened transcripts in memory).
4. Open the episode's transcript again. It is downloaded fresh and comes back translated.

A rewrite can't do this automatically: the transcript identifier the cache is keyed on comes from `amp-api.podcasts.apple.com`, and the app rejects MitM certificates for that host (certificate pinning), so no proxy can modify those responses.

## Good to know

- **Failures fall back to the original.** If some batches fail or time out, the finished sentences are still inserted and you get a notification. If nothing could be translated, the original transcript is returned untouched.
- Each request carries up to 8,000 characters or 200 sentences. A 15-minute episode needs 2 requests (~0.2 s); a 3.7-hour episode (37k words) needs 26 requests (~1 s), measured on a Mac with a direct connection to Google.

## What has been verified

Verified:
- **On iPhone with Quantumult X**: new episodes show bilingual transcripts.
- **End to end with real app traffic**: Podcasts for Mac (the Catalyst build of the iOS app) was run through mitmproxy with an addon that applies the same rewrite rule and runs this script the way Quantumult X does. The app downloaded transcripts from `podcasts.itunes.apple.com/itunes-assets/…/transcript_<id>.ttml`, accepted the MitM certificate for that host, and displayed the rewritten transcript in both languages. The sample at the top is what it showed.
- **Pinning**: the app rejects MitM certificates for `amp-api.podcasts.apple.com`, even when they are trusted.
- **Cache behavior**: opening a cached transcript makes no network request. Removing an episode's download deletes its cached transcript, and the next open re-downloads it (see the workaround above).
- **Real transcripts** (both Apple-generated and creator-provided): output is well-formed XML in all three modes, and every original word is kept in order.
- **Engine**: the script runs under JavaScriptCore, the engine Quantumult X uses.

Not verified:
- Word highlighting during playback on iOS. The Mac Transcript view doesn't highlight at all, so it couldn't be tested. If highlighting misbehaves, use `timing=end`.
- How `inline` and `only` look in the app. They use the same markup as `stack` but weren't checked on screen.

## Local testing

```
node test/run.js test/fixture.ttml --offline                          # no network, structure checks
node test/run.js some-episode.ttml --mode inline                      # real translation
node test/run.js some-episode.ttml --fail 1                           # first request fails, tests fallback
node test/run.js some-episode.ttml --offline --slow 1500 --timeout 2  # timeout handling
```

`test/run.js` mocks Quantumult X's `$task` / `$prefs` / `$done`, validates the output with `xmllint`, and checks that every original word survived.
