// ============================================================
// Cadence — app.js
// A no-build-step vanilla JS app, deliberately, matching the same simple
// pattern used elsewhere: easy to read top to bottom, easy to hand off.
// ============================================================

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------
var state = {
  words: [],              // flat [{text, clean}] across the whole document -- clean = lowercased, punctuation-stripped, for matching
  lines: [],               // [{number, startIndex, endIndex}] -- number is OUR OWN sequential display number, never derived from (and never re-adding) any number already in the source text
  currentIndex: 0,        // which word the highlighter (pacing timer OR AI-reading playback) is on
  paceWpm: 160,
  recording: false,
  paused: false,
  highlightTimer: null,
  mediaRecorder: null,
  recordedChunks: [],
  recognizedWords: [],    // accumulated recognized words across all record/pause/resume segments
  recognition: null,
  sessionStartTime: null,
  totalReadMs: 0,
  micStream: null
};

// ------------------------------------------------------------
// VOICE SELECTION -- same deliberate preference chain proven out in
// Circle Squared: a real, free, built-in voice, with a couple of named
// preferences tried first, always falling through gracefully to the
// browser's own default. See that project's docs/CODEX_LOGIC_V07.md
// Part L/LI for the reasoning this was carried over from.
// ------------------------------------------------------------
var _resolvedVoice = null;
var _voiceResolved = false;

function pickNamedVoice(voices, namePattern) {
  for (var i = 0; i < voices.length; i++) {
    if (voices[i].name && namePattern.test(voices[i].name)) return voices[i];
  }
  return null;
}

function resolveVoice(voices) {
  return pickNamedVoice(voices, /\bnatasha\b/i)
      || pickNamedVoice(voices, /\bgoogle\b/i)
      || pickNamedVoice(voices, /\baria\b/i)
      || null; // null -> browser's own current default voice/lang is used
}

// Simple, non-highlighted playback -- used only for the results screen's
// "tap a flagged word to hear it" (a single word, nothing to sync).
function speak(text, onEnd) {
  if (!window.speechSynthesis || !text) { if (onEnd) onEnd(); return; }
  window.speechSynthesis.cancel();
  var utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.95;

  function withVoice(voices) {
    if (!_voiceResolved && voices && voices.length) {
      _resolvedVoice = resolveVoice(voices);
      _voiceResolved = true;
    }
    if (_resolvedVoice) utter.voice = _resolvedVoice;
    utter.onend = function() { if (onEnd) onEnd(); };
    utter.onerror = function() { if (onEnd) onEnd(); };
    window.speechSynthesis.speak(utter);
  }

  var voices = window.speechSynthesis.getVoices();
  if (voices && voices.length) {
    withVoice(voices);
  } else {
    window.speechSynthesis.onvoiceschanged = function() { withVoice(window.speechSynthesis.getVoices()); };
    setTimeout(function() { if (!_voiceResolved) withVoice(window.speechSynthesis.getVoices()); }, 800);
  }
}

// ------------------------------------------------------------
// TEXT INTAKE + PARSING
//
// Splits into LINES (by newline -- matching how a numbered practice
// script is actually formatted) rather than sentences. Any number
// already at the start of a line in the SOURCE text (e.g. "1. ", "2) ",
// "(3) ") is stripped and never becomes part of what gets spoken or
// matched -- Cadence always generates its OWN sequential display number
// instead, so a gap or inconsistency in the source's own numbering never
// matters, and numbers are never accidentally read aloud as words.
// ------------------------------------------------------------
var textInput = document.getElementById('text-input');
var fileInput = document.getElementById('file-input');
var uploadFilename = document.getElementById('upload-filename');
var startBtn = document.getElementById('start-btn');

textInput.addEventListener('input', updateStartBtn);
function updateStartBtn() {
  startBtn.disabled = textInput.value.trim().length === 0;
}

fileInput.addEventListener('change', function() {
  var file = fileInput.files[0];
  if (!file) return;
  uploadFilename.textContent = file.name;
  var reader = new FileReader();
  reader.onload = function(e) {
    textInput.value = String(e.target.result || '');
    updateStartBtn();
  };
  reader.readAsText(file);
});

function cleanWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '');
}

var LEADING_NUMBER_RE = /^\(?\d+\)?\s*[.):-]?\s+/;

function parseText(text) {
  var rawLines = text.split(/\r?\n/);
  var words = [];
  var lines = [];
  var displayNumber = 0;

  rawLines.forEach(function(rawLine) {
    var trimmed = rawLine.trim();
    if (!trimmed) return; // blank lines are just spacing in the source -- skip them entirely, don't burn a number on them

    var withoutLeadingNumber = trimmed.replace(LEADING_NUMBER_RE, '');
    displayNumber++;
    var startIndex = words.length;
    var lineWords = withoutLeadingNumber.split(/\s+/).filter(function(w) { return w.length > 0; });
    lineWords.forEach(function(w) { words.push({ text: w, clean: cleanWord(w) }); });

    // A line that was ONLY a number (rare, but possible with odd source
    // formatting) ends up with zero words after stripping -- skip adding
    // an empty line rather than showing a bare number with nothing after it.
    if (lineWords.length > 0) {
      lines.push({ number: displayNumber, startIndex: startIndex, endIndex: words.length - 1 });
    } else {
      displayNumber--;
    }
  });

  return { words: words, lines: lines };
}

startBtn.addEventListener('click', function() {
  var parsed = parseText(textInput.value);
  state.words = parsed.words;
  state.lines = parsed.lines;
  state.currentIndex = 0;
  state.recognizedWords = [];
  state.totalReadMs = 0;
  renderReadingText();
  showScreen('screen-reading');
});

document.getElementById('back-btn').addEventListener('click', function() {
  stopEverything();
  stopExampleSpeech();
  showScreen('screen-upload');
});

// ------------------------------------------------------------
// SCREENS
// ------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

// ------------------------------------------------------------
// DICTATE + AUTO-FORMAT
//
// Reuses the exact same SpeechRecognition mechanism already proven out
// for scoring a practice reading -- just pointed at free-form speech
// instead of a known text to compare against. "Formatting" is real,
// deterministic voice commands (the same convention Google Docs voice
// typing and Apple Dictation both use) -- say "period", "comma", "new
// paragraph", etc. and they become real punctuation/structure. This is
// a free, zero-infrastructure way to do real formatting; a smarter
// AI-based cleanup pass (fixing run-ons, inferring paragraphs without
// being told to) is a separate, bigger decision -- see the project's
// README for why that's treated deliberately rather than bundled in here.
// ------------------------------------------------------------
var VOICE_COMMAND_RULES = [
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
  [/\bfull stop\b/gi, '.'],
  [/\bexclamation (?:point|mark)\b/gi, '!'],
  [/\bquestion mark\b/gi, '?'],
  [/\bopen quote\b/gi, '"'],
  [/\bclose quote\b/gi, '"'],
  [/\bsemicolon\b/gi, ';'],
  [/\bcolon\b/gi, ':'],
  [/\bcomma\b/gi, ','],
  [/\bperiod\b/gi, '.'],
  [/\bhyphen\b/gi, '-'],
  [/\bdash\b/gi, '-']
];

function applyVoiceCommands(text) {
  VOICE_COMMAND_RULES.forEach(function(rule) { text = text.replace(rule[0], rule[1]); });
  text = text.replace(/[ \t]+([.,!?;:])/g, '$1');   // drop the space left behind before punctuation
  text = text.replace(/[ \t]*\n[ \t]*/g, '\n');      // clean spacing around inserted line/paragraph breaks
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text.trim();
}

function autoCapitalize(text) {
  return text.replace(/(^\s*|[.!?]\s+|\n+\s*)([a-z])/g, function(m, sep, letter) {
    return sep + letter.toUpperCase();
  });
}

function processDictation(text) {
  return autoCapitalize(applyVoiceCommands(text));
}

var dictateState = {
  rawText: '',
  recognition: null,
  dictating: false
};

var dictateOutput = document.getElementById('dictate-output');

document.getElementById('go-dictate-btn').addEventListener('click', function() {
  showScreen('screen-dictate');
});

document.getElementById('dictate-back-btn').addEventListener('click', function() {
  stopDictation();
  showScreen('screen-upload');
});

document.getElementById('dictate-start-btn').addEventListener('click', function() {
  startDictation();
});

document.getElementById('dictate-stop-btn').addEventListener('click', function() {
  stopDictation();
});

document.getElementById('dictate-use-btn').addEventListener('click', function() {
  textInput.value = processDictation(dictateState.rawText);
  updateStartBtn();
  showScreen('screen-upload');
});

function renderDictateOutput(interimText) {
  var formatted = processDictation(dictateState.rawText);
  dictateOutput.textContent = formatted;
  if (interimText) {
    var interimSpan = document.createElement('span');
    interimSpan.className = 'interim';
    interimSpan.textContent = (formatted ? ' ' : '') + interimText;
    dictateOutput.appendChild(interimSpan);
  }
}

function startDictation() {
  if (!SpeechRecognitionCtor) {
    alert('This browser doesn’t support speech recognition, so dictation isn’t available here. Typing or pasting your text still works fine.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('This browser does not support microphone access.');
    return;
  }

  navigator.mediaDevices.getUserMedia({ audio: true }).then(function() {
    dictateState.dictating = true;
    document.getElementById('dictate-start-btn').hidden = true;
    document.getElementById('dictate-stop-btn').hidden = false;
    document.getElementById('dictate-use-btn').hidden = true;

    dictateState.recognition = new SpeechRecognitionCtor();
    dictateState.recognition.continuous = true;
    dictateState.recognition.interimResults = true;
    dictateState.recognition.onresult = function(event) {
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var transcript = event.results[i][0].transcript || '';
        if (event.results[i].isFinal) {
          dictateState.rawText += (dictateState.rawText ? ' ' : '') + transcript.trim();
        } else {
          interim += transcript;
        }
      }
      renderDictateOutput(interim);
    };
    dictateState.recognition.onerror = function() { /* non-fatal -- keep listening/allow manual stop */ };
    dictateState.recognition.onend = function() {
      // Some browsers end recognition on their own after a pause even
      // with continuous:true -- restart automatically unless the person
      // actually pressed Stop.
      if (dictateState.dictating) {
        try { dictateState.recognition.start(); } catch (e) {}
      }
    };
    try { dictateState.recognition.start(); } catch (e) {}
  }).catch(function() {
    alert('Microphone access is needed to dictate. Please allow it and try again.');
  });
}

function stopDictation() {
  dictateState.dictating = false;
  if (dictateState.recognition) { try { dictateState.recognition.stop(); } catch (e) {} }
  document.getElementById('dictate-start-btn').hidden = false;
  document.getElementById('dictate-stop-btn').hidden = true;
  document.getElementById('dictate-use-btn').hidden = dictateState.rawText.length === 0;
  renderDictateOutput('');
}

// ------------------------------------------------------------
// PACE SETTINGS
// ------------------------------------------------------------
var paceSlider = document.getElementById('pace-slider');
var paceDisplay = document.getElementById('pace-display');
paceSlider.addEventListener('input', function() {
  state.paceWpm = parseInt(paceSlider.value, 10);
  paceDisplay.textContent = state.paceWpm + ' wpm';
});

document.getElementById('settings-toggle-btn').addEventListener('click', function() {
  var panel = document.getElementById('more-settings');
  panel.hidden = !panel.hidden;
});

// ------------------------------------------------------------
// AI VOICE READING (opening lines OR the full text), WITH THE SAME WORD
// HIGHLIGHTER USED DURING RECORDING
//
// speakRange() speaks one line's words as a single utterance and drives
// state.currentIndex from the browser's own `onboundary` word-boundary
// events, so the highlighter tracks the ACTUAL voice as it speaks --
// rather than a fixed timer, which is what drives the highlighter later
// during the reader's own recording (see startHighlightTimer()). Chained
// line-by-line (not one utterance for the whole document) so long texts
// stay reliable and the highlighter naturally resets to each line's start.
// ------------------------------------------------------------
var _exampleReadingCancelled = false;

function speakRange(startIdx, endIdx, onEnd) {
  var subset = state.words.slice(startIdx, endIdx + 1);
  var text = subset.map(function(w) { return w.text; }).join(' ');
  if (!text) { if (onEnd) onEnd(); return; }

  // Character offset of each word within `text`, so onboundary's
  // charIndex can be mapped back to which word is currently being spoken.
  var offsets = [];
  var pos = 0;
  subset.forEach(function(w) {
    offsets.push(pos);
    pos += w.text.length + 1; // +1 accounts for the joining space
  });

  if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }
  window.speechSynthesis.cancel();
  var utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.95;

  function withVoice(voices) {
    if (!_voiceResolved && voices && voices.length) {
      _resolvedVoice = resolveVoice(voices);
      _voiceResolved = true;
    }
    if (_resolvedVoice) utter.voice = _resolvedVoice;

    utter.onboundary = function(e) {
      // Some engines only ever fire word boundaries; others also fire
      // sentence boundaries -- only word events should move the highlighter.
      if (e.name && e.name !== 'word') return;
      var wIdx = 0;
      for (var k = 0; k < offsets.length; k++) {
        if (offsets[k] <= e.charIndex) wIdx = k; else break;
      }
      state.currentIndex = startIdx + wIdx;
      updateHighlight();
    };
    utter.onend = function() { if (onEnd) onEnd(); };
    utter.onerror = function() { if (onEnd) onEnd(); };
    window.speechSynthesis.speak(utter);
  }

  var voices = window.speechSynthesis.getVoices();
  if (voices && voices.length) {
    withVoice(voices);
  } else {
    window.speechSynthesis.onvoiceschanged = function() { withVoice(window.speechSynthesis.getVoices()); };
    setTimeout(function() { if (!_voiceResolved) withVoice(window.speechSynthesis.getVoices()); }, 800);
  }
}

function speakLines(lineList, onEnd) {
  var idx = 0;
  function next() {
    // Checked on every step, not just at the start, so Stop can interrupt
    // mid-chain -- calling speechSynthesis.cancel() alone isn't enough,
    // since some browsers still fire the pending utterance's onend and
    // would otherwise just continue on to the next line.
    if (_exampleReadingCancelled || idx >= lineList.length) { if (onEnd) onEnd(); return; }
    var line = lineList[idx];
    idx++;
    speakRange(line.startIndex, line.endIndex, next);
  }
  next();
}

function setExamplePlayingUI(isPlaying) {
  document.getElementById('play-example-btn').hidden = isPlaying;
  document.getElementById('play-full-btn').hidden = isPlaying;
  document.getElementById('stop-example-btn').hidden = !isPlaying;
}

document.getElementById('play-example-btn').addEventListener('click', function() {
  if (!state.lines.length) return;
  _exampleReadingCancelled = false;
  setExamplePlayingUI(true);
  document.getElementById('example-status').textContent = '🔊 Playing the opening…';
  var opening = state.lines.slice(0, 2); // first 1-2 lines -- enough to set tone/pace, not the whole document
  speakLines(opening, function() {
    setExamplePlayingUI(false);
    document.getElementById('example-status').textContent = '';
  });
});

document.getElementById('play-full-btn').addEventListener('click', function() {
  if (!state.lines.length) return;
  _exampleReadingCancelled = false;
  setExamplePlayingUI(true);
  document.getElementById('example-status').textContent = '🔊 Reading the full text…';
  speakLines(state.lines, function() {
    setExamplePlayingUI(false);
    document.getElementById('example-status').textContent = '';
  });
});

document.getElementById('stop-example-btn').addEventListener('click', function() {
  stopExampleSpeech();
});

function stopExampleSpeech() {
  _exampleReadingCancelled = true;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  setExamplePlayingUI(false);
  document.getElementById('example-status').textContent = '';
}

// ------------------------------------------------------------
// RENDERING THE PACING TEXT -- grouped by line, each with a visible
// display number that is NEVER part of state.words (see parseText()) so
// it can never end up highlighted, matched, or spoken.
// ------------------------------------------------------------
function renderReadingText() {
  var container = document.getElementById('reading-text');
  container.innerHTML = '';
  state.lines.forEach(function(line) {
    var lineDiv = document.createElement('div');
    lineDiv.className = 'reading-line';

    var numSpan = document.createElement('span');
    numSpan.className = 'line-number';
    numSpan.textContent = line.number + '.';
    lineDiv.appendChild(numSpan);

    for (var i = line.startIndex; i <= line.endIndex; i++) {
      lineDiv.appendChild(makeWordSpan(i, false));
    }
    container.appendChild(lineDiv);
  });
  updateHighlight();
}

function makeWordSpan(i, forResults) {
  var w = state.words[i];
  var span = document.createElement('span');
  span.className = 'word';
  span.textContent = w.text + ' ';
  span.dataset.index = i;
  if (!forResults) {
    span.addEventListener('click', function() {
      if (state.paused) repositionTo(i);
    });
  }
  return span;
}

function updateHighlight() {
  var spans = document.querySelectorAll('#reading-text .word');
  spans.forEach(function(span, i) {
    span.classList.toggle('current', i === state.currentIndex);
    span.classList.toggle('read', i < state.currentIndex);
  });
  var current = spans[state.currentIndex];
  if (current) current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function repositionTo(index) {
  state.currentIndex = index;
  updateHighlight();
}

// ------------------------------------------------------------
// RECORDING + PACING HIGHLIGHT + LIVE SPEECH RECOGNITION
//
// The standard browser SpeechRecognition API only ever listens to a LIVE
// microphone stream -- it cannot transcribe an already-recorded audio
// file. So recognition runs concurrently with MediaRecorder, both
// attached to the same mic stream, rather than as a second pass
// afterward. See docs/PLAN.md for why this shape was chosen.
// ------------------------------------------------------------
var recordBtn = document.getElementById('record-btn');
var pauseBtn = document.getElementById('pause-btn');
var finishBtn = document.getElementById('finish-btn');
var repositionHint = document.getElementById('reposition-hint');

var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

recordBtn.addEventListener('click', function() {
  if (!state.recording) startOrResumeRecording();
});

pauseBtn.addEventListener('click', function() {
  pauseRecording();
});

finishBtn.addEventListener('click', function() {
  finishRecording();
});

function startOrResumeRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('This browser does not support microphone recording.');
    return;
  }

  // Never let the AI's own example reading keep talking (or keep the
  // highlighter under its control) once the reader starts recording.
  stopExampleSpeech();

  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    state.micStream = stream;
    state.recording = true;
    state.paused = false;
    repositionHint.hidden = true;
    recordBtn.hidden = true;
    pauseBtn.hidden = false;
    finishBtn.hidden = false;

    // MediaRecorder: captures a continuous recording across the whole
    // session for playback/review -- started fresh each resume, chunks
    // accumulated in state.recordedChunks so pausing/resuming doesn't
    // lose earlier audio.
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.start();

    // Live recognition for THIS segment only -- results get appended to
    // state.recognizedWords when this segment ends (pause or finish).
    if (SpeechRecognitionCtor) {
      state.recognition = new SpeechRecognitionCtor();
      state.recognition.continuous = true;
      state.recognition.interimResults = false;
      state.recognition.onresult = function(event) {
        for (var i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            var transcript = event.results[i][0].transcript || '';
            transcript.trim().split(/\s+/).forEach(function(w) {
              if (w) state.recognizedWords.push(cleanWord(w));
            });
          }
        }
      };
      state.recognition.onerror = function() { /* non-fatal -- recording continues regardless */ };
      try { state.recognition.start(); } catch (e) { /* already started, ignore */ }
    }

    state.sessionStartTime = Date.now();
    startHighlightTimer();
  }).catch(function() {
    alert('Microphone access is needed to record your reading. Please allow it and try again.');
  });
}

function startHighlightTimer() {
  // Advances one word at the current pace (wpm -> ms per word). A plain
  // timer, not tied to live recognition results -- see docs/PLAN.md for
  // why a steady, predictable pace is more reliable than trying to track
  // the reader's actual voice in real time.
  var msPerWord = 60000 / state.paceWpm;
  clearInterval(state.highlightTimer);
  state.highlightTimer = setInterval(function() {
    if (state.currentIndex < state.words.length - 1) {
      state.currentIndex++;
      updateHighlight();
    } else {
      clearInterval(state.highlightTimer);
    }
  }, msPerWord);
}

function pauseRecording() {
  state.paused = true;
  state.recording = false;
  clearInterval(state.highlightTimer);
  if (state.sessionStartTime) state.totalReadMs += Date.now() - state.sessionStartTime;

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
  if (state.recognition) { try { state.recognition.stop(); } catch (e) {} }
  if (state.micStream) state.micStream.getTracks().forEach(function(t) { t.stop(); });

  recordBtn.hidden = false;
  recordBtn.textContent = '⏺ Resume Reading';
  pauseBtn.hidden = true;
  repositionHint.hidden = false;
}

function finishRecording() {
  clearInterval(state.highlightTimer);
  if (state.sessionStartTime) state.totalReadMs += Date.now() - state.sessionStartTime;

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.onstop = function() { showResults(); };
    state.mediaRecorder.stop();
  } else {
    showResults();
  }
  if (state.recognition) { try { state.recognition.stop(); } catch (e) {} }
  if (state.micStream) state.micStream.getTracks().forEach(function(t) { t.stop(); });

  state.recording = false;
  state.paused = false;
}

function stopEverything() {
  clearInterval(state.highlightTimer);
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
  if (state.recognition) { try { state.recognition.stop(); } catch (e) {} }
  if (state.micStream) state.micStream.getTracks().forEach(function(t) { t.stop(); });
  state.recording = false;
  state.paused = false;
  state.recordedChunks = [];
  recordBtn.hidden = false;
  recordBtn.textContent = '⏺ Start Reading';
  pauseBtn.hidden = true;
  finishBtn.hidden = true;
  repositionHint.hidden = true;
}

// ------------------------------------------------------------
// WORD-LEVEL ALIGNMENT (longest common subsequence) -- compares what was
// actually recognized against the real text so genuinely out-of-order
// insertions/deletions (skipped words, added words) are handled
// reasonably, not just a naive position-by-position comparison.
// ------------------------------------------------------------
function alignWords(original, recognized) {
  var n = original.length, m = recognized.length;
  var dp = [];
  for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (i = 1; i <= n; i++) {
    for (var j = 1; j <= m; j++) {
      if (original[i - 1] === recognized[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  var matched = new Array(n).fill(false);
  i = n; var j = m;
  while (i > 0 && j > 0) {
    if (original[i - 1] === recognized[j - 1]) { matched[i - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return matched; // matched[k] === true -> original word k was found in the recognized speech
}

// ------------------------------------------------------------
// RESULTS
// ------------------------------------------------------------
function showResults() {
  var originalClean = state.words.map(function(w) { return w.clean; });
  var matched = SpeechRecognitionCtor
    ? alignWords(originalClean, state.recognizedWords)
    : originalClean.map(function() { return true; }); // no recognition available -- don't falsely flag everything

  var flaggedCount = matched.filter(function(m) { return !m; }).length;
  var totalWords = state.words.length;
  var accuracyPct = totalWords ? Math.round(((totalWords - flaggedCount) / totalWords) * 100) : 0;
  var minutes = state.totalReadMs / 60000;
  var wpm = minutes > 0 ? Math.round(totalWords / minutes) : 0;

  document.getElementById('stat-accuracy').textContent = SpeechRecognitionCtor ? (accuracyPct + '%') : '—';
  document.getElementById('stat-pace').textContent = wpm ? (wpm + ' wpm') : '—';
  document.getElementById('stat-flagged').textContent = SpeechRecognitionCtor ? String(flaggedCount) : '—';

  var existingNote = document.getElementById('no-recognition-note');
  if (existingNote) existingNote.remove();
  if (!SpeechRecognitionCtor) {
    var note = document.createElement('p');
    note.id = 'no-recognition-note';
    note.className = 'hint';
    note.textContent = 'This browser doesn’t support live speech recognition, so word-accuracy feedback isn’t available here — pacing is still tracked.';
    document.getElementById('results-text').parentNode.insertBefore(note, document.getElementById('results-text'));
  }

  var resultsText = document.getElementById('results-text');
  resultsText.innerHTML = '';
  state.lines.forEach(function(line) {
    var lineDiv = document.createElement('div');
    lineDiv.className = 'reading-line';
    var numSpan = document.createElement('span');
    numSpan.className = 'line-number';
    numSpan.textContent = line.number + '.';
    lineDiv.appendChild(numSpan);
    for (var i = line.startIndex; i <= line.endIndex; i++) {
      var w = state.words[i];
      var span = makeWordSpan(i, true);
      if (!matched[i]) {
        span.classList.add('flagged');
        span.title = 'Tap to hear how this should sound';
        (function(word) { span.addEventListener('click', function() { speak(word); }); })(w.text);
      }
      lineDiv.appendChild(span);
    }
    resultsText.appendChild(lineDiv);
  });

  var playbackRow = document.getElementById('playback-row');
  if (state.recordedChunks.length) {
    var blob = new Blob(state.recordedChunks, { type: 'audio/webm' });
    var url = URL.createObjectURL(blob);
    document.getElementById('recording-playback').src = url;
    playbackRow.hidden = false;
  } else {
    playbackRow.hidden = true;
  }

  showScreen('screen-results');
}

document.getElementById('try-again-btn').addEventListener('click', function() {
  state.currentIndex = 0;
  state.recognizedWords = [];
  state.recordedChunks = [];
  state.totalReadMs = 0;
  recordBtn.textContent = '⏺ Start Reading';
  finishBtn.hidden = true;
  renderReadingText();
  showScreen('screen-reading');
});

document.getElementById('new-text-btn').addEventListener('click', function() {
  textInput.value = '';
  uploadFilename.textContent = '';
  updateStartBtn();
  showScreen('screen-upload');
});
