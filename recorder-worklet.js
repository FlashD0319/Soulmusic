// 干声采集 AudioWorklet 处理器
// 从麦克风输入流中抓取原始干声，按帧回传给主线程用于录音。
"use strict";

class DryRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      this.recording = !!(e.data && e.data.recording);
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.port.postMessage(ch.slice(0));
    }
    return true;
  }
}

registerProcessor("dry-recorder", DryRecorderProcessor);
