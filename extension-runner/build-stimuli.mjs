import { execFileSync } from 'node:child_process';
import { stimulusFor } from './stimulus.mjs';
const files = new Map();
for (const mode of ['interview', 'tab-only', 'microphone-only', 'practice']) {
  const stimulus = stimulusFor(mode);
  for (const source of [stimulus.microphone, stimulus.tab]) {
    if (source.phrase) files.set(source.file, source.phrase);
  }
}
for (const [file, phrase] of files) execFileSync('espeak-ng', ['-v', 'en-us', '-w', `/opt/runner/${file}`, phrase]);
// Leave the coach a full turn between repeated candidate utterances.
execFileSync('python3', ['-c', "import wave; p='/opt/runner/practice-answer.wav'; r=wave.open(p,'rb'); params=r.getparams(); data=r.readframes(r.getnframes()); r.close(); w=wave.open(p,'wb'); w.setparams(params); w.writeframes(data+bytes(params.framerate*params.sampwidth*params.nchannels*25)); w.close()"]);
execFileSync('python3', ['-c', "import wave; w=wave.open('/opt/runner/silence.wav','wb'); w.setparams((1,2,24000,0,'NONE','not compressed')); w.writeframes(bytes(48000*3)); w.close()"]);
