// ============================================================
// Cadence — app.js
// A no-build-step vanilla JS app, deliberately, matching the same simple
// pattern used elsewhere: easy to read top to bottom, easy to hand off.
// ============================================================

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------
var state = {
  words: [],              // [{text, clean}] -- clean = lowercased, punctuation-stripped, for matching
  currentIndex: 0,        // which word the pacing highlighter is on
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
    // Safety timeout in case voiceschanged never fires on this browser.
    setTimeout(function() { if (!_voiceResolved) withVoice(window.speechSynthesis.getVoices()); }, 800);
  }
}

// ------------------------------------------------------------
// TEXT INTAKE
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

function tokenize(text) {
  var raw = text.trim().split(/\s+/).filter(function(w) { return w.length > 0; });
  return raw.map(function(w) { return { text: w, clean: cleanWord(w) }; });
}

startBtn.addEventListener('click', function() {
  state.words = tokenize(textInput.value);
  state.currentIndex = 0;
  state.recognizedWords = [];
  state.totalReadMs = 0;
  renderReadingText();
  showScreen('screen-reading');
});

document.getElementById('back-btn').addEventListener('click', function() {
  stopEverything();
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
// "HEAR THE OPENING LINES" -- reads roughly the first 2-3 sentences (or
// the first ~25 words if the text has no clear sentence breaks) to set
// tone and pace, NOT the whole document.
// ------------------------------------------------------------
document.getElementById('play-example-btn').addEventListener('click', function() {
  var status = document.getElementById('example-status');
  var fullText = textInput.value;
  var sentenceMatch = fullText.match(/(?:[^.!?]+[.!?]+){1,3}/);
  var opening = sentenceMatch ? sentenceMatch[0].trim() : state.words.slice(0, 25).map(function(w){return w.text;}).join(' ');
  status.textContent = '🔊 Playing…';
  speak(opening, function() { status.textContent = ''; });
});

// ------------------------------------------------------------
// RENDERING THE PACING TEXT (clickable words, current-word highlight)
// ------------------------------------------------------------
function renderReadingText() {
  var container = document.getElementById('reading-text');
  container.innerHTML = '';
  state.words.forEach(function(w, i) {
    var span = document.createElement('span');
    span.className = 'word';
    span.textContent = w.text + ' ';
    span.dataset.index = i;
    span.addEventListener('click', function() {
      if (state.paused) repositionTo(i);
    });
    container.appendChild(span);
  });
  updateHighlight();
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

  if (!SpeechRecognitionCtor) {
    var note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'This browser doesn’t support live speech recognition, so word-accuracy feedback isn’t available here — pacing is still tracked.';
    document.getElementById('results-text').parentNode.insertBefore(note, document.getElementById('results-text'));
  }

  var resultsText = document.getElementById('results-text');
  resultsText.innerHTML = '';
  state.words.forEach(function(w, i) {
    var span = document.createElement('span');
    span.className = 'word' + (!matched[i] ? ' flagged' : '');
    span.textContent = w.text + ' ';
    if (!matched[i]) {
      span.title = 'Tap to hear how this should sound';
      span.addEventListener('click', function() { speak(w.text); });
    }
    resultsText.appendChild(span);
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
