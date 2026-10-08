/* Lodging Reels media timeline and audio postprocessing.
 * Audio processing: @soundtouchjs/audio-worklet (MPL-2.0), loaded on demand.
 * https://github.com/cutterbl/SoundTouchJS
 * ElevenLabs aligned character timings are in the ORIGINAL speech timebase.
 */
(function (root) {
  "use strict";
  var SPEED = 1.2;
  var PITCH_SEMITONES = 0.2;
  var DSP_VERSION = "soundtouch-2.1.1-speed1.2-pitch0.2";

  function speechLetters(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLocaleLowerCase("ko-KR")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }
  function withoutTags(text) {
    return String(text || "").replace(/\[[^\[\]\r\n]{1,200}\]/g, "");
  }

  // A tag like [excited] may be present in ElevenLabs' original alignment.
  // Skip bracketed tags without losing character timestamps.
  function timedSpeechCharacters(alignment) {
    if (!alignment || !Array.isArray(alignment.characters) ||
        !Array.isArray(alignment.character_start_times_seconds) ||
        !Array.isArray(alignment.character_end_times_seconds)) {
      throw new Error("ElevenLabs 문자별 타임스탬프가 없어요. TTS를 다시 생성해주세요.");
    }
    var c = alignment.characters;
    var starts = alignment.character_start_times_seconds;
    var ends = alignment.character_end_times_seconds;
    if (c.length !== starts.length || c.length !== ends.length) {
      throw new Error("타임스탬프의 문자와 시간이 맞지 않아요.");
    }
    var inTag = false;
    var map = [];
    var output = "";
    for (var i = 0; i < c.length; i++) {
      var text = String(c[i] == null ? "" : c[i]);
      for (var ch of text) {
        if (ch === "[") { inTag = true; continue; }
        if (inTag) { if (ch === "]") inTag = false; continue; }
        var normalized = speechLetters(ch);
        for (var letter of normalized) {
          var start = Number(starts[i]), end = Number(ends[i]);
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
            throw new Error("TTS 타임스탬프에 잘못된 값이 있어요.");
          }
          output += letter;
          map.push({ ch: letter, start: start, end: end });
        }
      }
    }
    return { text: output, chars: map };
  }

  function timelineFromAlignment(lines, alignment, processedDuration, speed) {
    speed = Number(speed) || SPEED;
    if (!Array.isArray(lines) || !lines.length) throw new Error("먼저 대본을 만들어주세요.");
    if (!(processedDuration > 0) || !Number.isFinite(processedDuration)) {
      throw new Error("후처리한 음성 길이가 올바르지 않아요.");
    }
    var chunks = lines.map(function (s) { return speechLetters(s); });
    if (chunks.some(function (s) { return !s; })) {
      throw new Error("글자가 없는 자막 컷이 있어요. 해당 컷을 수정해주세요.");
    }
    var aligned = timedSpeechCharacters(alignment);
    var expected = chunks.join("");
    if (aligned.text !== expected) {
      var first = 0;
      while (first < Math.min(aligned.text.length, expected.length) &&
             aligned.text[first] === expected[first]) first++;
      var e = new Error("음성 타임스탬프와 대본이 일치하지 않아요 (불일치 지점 " + (first+1) + "). 정확하지 않은 임의 싱크는 적용하지 않습니다.");
      e.code = "align_text_mismatch";
      throw e;
    }
    var map = aligned.chars;
    var boundaries = [0];
    var cursor = 0;
    for (var i = 0; i < chunks.length; i++) {
      if (i > 0) {
        var st = map[cursor].start / speed;
        if (!(st > boundaries[i-1] + 0.01) || st >= processedDuration) {
          throw new Error("서로 겹치거나 영상 길이를 넘는 컷 타이밍이 있어요. 싱크를 수동으로 조절하거나 음성을 다시 만들어주세요.");
        }
        boundaries.push(st);
      }
      cursor += chunks[i].length;
    }
    boundaries.push(processedDuration);
    var timeline = [];
    for (var j = 0; j < chunks.length; j++) {
      var start = boundaries[j], end = boundaries[j+1];
      if (!(end > start)) throw new Error("자막 컷 길이가 0초예요.");
      timeline.push({
        start: +start.toFixed(3),
        end: +end.toFixed(3),
        duration: +(end-start).toFixed(3),
        text: String(lines[j]),
      });
    }
    return timeline;
  }

  function wavFromBuffer(buffer) {
    var channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
    var sampleRate = buffer.sampleRate;
    var sampleCount = buffer.length;
    var byteSize = sampleCount * channels * 2;
    var headerSize = 44;
    var raw = new ArrayBuffer(headerSize + byteSize);
    var view = new DataView(raw);
    function writeStr(offset, str) {
      for (var i=0; i<str.length; i++) view.setUint8(offset+i, str.charCodeAt(i));
    }
    writeStr(0,"RIFF");
    view.setUint32(4,36+byteSize,true);
    writeStr(8,"WAVE");
    writeStr(12,"fmt ");
    view.setUint32(16,16,true);
    view.setUint16(20,1,true);
    view.setUint16(22,channels,true);
    view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*channels*2,true);
    view.setUint16(32,channels*2,true);
    view.setUint16(34,16,true);
    writeStr(36,"data");
    view.setUint32(40,byteSize,true);
    var data=[];
    for (var c=0; c<channels; c++) data.push(buffer.getChannelData(c));
    var p=44, peak=0;
    for (var frame=0; frame<sampleCount; frame++) {
      for (var chan=0; chan<channels; chan++) {
        var sample=Math.max(-1,Math.min(1,data[chan][frame]));
        peak=Math.max(peak,Math.abs(sample));
        view.setInt16(p,sample<0?Math.round(sample*32768):Math.round(sample*32767),true);
        p+=2;
      }
    }
    if (peak < 0.002) throw new Error("후처리한 음성이 거의 무음이에요. 저장하지 않았습니다.");
    return new Blob([raw],{type:"audio/wav"});
  }

  async function processAudio(originalBlob) {
    if (!originalBlob || !originalBlob.size) throw new Error("원본 TTS 파일이 없어요.");
    if (!window.AudioContext && !window.webkitAudioContext) {
      throw new Error("이 브라우저에서 음성 후처리를 지원하지 않아요.");
    }
    if (!window.OfflineAudioContext) {
      throw new Error("이 브라우저에서 OfflineAudioContext를 사용할 수 없어요.");
    }
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var audio;
    try {
      audio = await ctx.decodeAudioData(await originalBlob.arrayBuffer());
    } finally {
      try { await ctx.close(); } catch (e) {}
    }
    if (!audio || !audio.length || audio.duration > 180) {
      throw new Error("음성 파일이 비어 있거나 너무 길어요.");
    }
    var lib;
    try {
      lib = await import("https://esm.sh/@soundtouchjs/audio-worklet@2.1.1");
    } catch (e) {
      throw new Error("음성 후처리 모듈을 불러오지 못했어요. 네트워크를 확인해주세요.");
    }
    if (!lib || typeof lib.processOffline !== "function") {
      throw new Error("음성 후처리 모듈의 버전이 맞지 않아요.");
    }
    var urls = [
      "https://cdn.jsdelivr.net/npm/@soundtouchjs/audio-worklet@2.1.1/.dist/soundtouch-processor.js",
      "https://unpkg.com/@soundtouchjs/audio-worklet@2.1.1/.dist/soundtouch-processor.js",
    ];
    var processed=null, lastError=null;
    for (var i=0; i<urls.length; i++) {
      try {
        processed = await lib.processOffline({
          input:audio,
          processorUrl:urls[i],
          playbackRate:SPEED,
          pitchSemitones:PITCH_SEMITONES,
        });
        if (processed && processed.length) break;
      } catch (e) {
        lastError=e;
      }
    }
    if (!processed || !processed.length) {
      throw new Error("속도·피치를 따로 조절하는 음성 처리에 실패했어요. " +
        ((lastError && lastError.message) || "다시 시도해주세요.").slice(0,90));
    }
    var target=audio.duration / SPEED;
    if (Math.abs(processed.duration-target)>Math.max(0.13,target*0.03)) {
      throw new Error("후처리 음성 길이가 예상값과 달라서 저장을 중단했어요.");
    }
    return {
      blob: wavFromBuffer(processed),
      duration: processed.duration,
      originalDuration: audio.duration,
      speed:SPEED,
      pitchSemitones:PITCH_SEMITONES,
      version:DSP_VERSION,
    };
  }
  root.ReelsMedia = Object.freeze({
    SPEED:SPEED,
    PITCH_SEMITONES:PITCH_SEMITONES,
    VERSION:DSP_VERSION,
    speechLetters:speechLetters,
    withoutTags:withoutTags,
    timedSpeechCharacters:timedSpeechCharacters,
    timelineFromAlignment:timelineFromAlignment,
    wavFromBuffer:wavFromBuffer,
    processAudio:processAudio,
  });
})(window);
