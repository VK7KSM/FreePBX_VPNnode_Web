/* 使用上游 WebRTC AEC3；反馈参考取自实际送出样本，不采集设备端声音。 */
class ElfPttAecProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.alive = true;
    this.enabled = false;
    this.frameSize = 480;
    this.referenceDelay = 2160;
    this.inputFrame = new Float32Array(480);
    this.referenceFrame = new Float32Array(480);
    this.processedFrame = new Float32Array(480);
    this.history = new Float32Array(2160);
    this.queue = new Float32Array(960);
    this.clear();
    this.port.onmessage = ({data}) => {
      if (data.type === 'close') {
        this.alive = false;
        this.aec?.free(); this.aec = null;
      } else if (data.type === 'mode') {
        const enabled = data.mode === 'ptt';
        if (this.enabled && !enabled) this.reset();
        this.enabled = enabled;
      }
    };
    WebRtcAec3({instantiateWasm: (imports, receive) => {
      const instance = new WebAssembly.Instance(options.processorOptions.module, imports);
      receive(instance); return instance.exports;
    }}).then(module => {
      if (!this.alive) return;
      this.module = module;
      this.reset();
      this.port.postMessage({type:'ready'});
    }).catch(() => this.port.postMessage({type:'error'}));
  }
  clear() {
    this.inputFrame.fill(0); this.referenceFrame.fill(0);
    this.history.fill(0); this.queue.fill(0);
    this.frameAt = 0; this.historyAt = 0;
    this.readAt = 0; this.writeAt = 480; this.queued = 480;
  }
  reset() {
    this.aec?.free();
    this.aec = this.module ? new this.module.AEC3(48000, 1, 1) : null;
    this.clear();
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return this.alive;
    output.fill(0);
    if (!this.alive || !this.enabled || !this.aec) return this.alive;
    const input = inputs[0]?.[0];
    try {
      for (let i = 0; i < output.length; i++) {
        this.inputFrame[this.frameAt] = input?.[i] || 0;
        // 仅延迟参考，避开近端讲话的自相关；发送音频不额外等待此窗口。
        this.referenceFrame[this.frameAt] = this.history[this.historyAt];
        const sample = this.queued ? this.queue[this.readAt] : 0;
        if (this.queued) { this.readAt = (this.readAt + 1) % 960; this.queued--; }
        output[i] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
        this.history[this.historyAt] = output[i];
        this.historyAt = (this.historyAt + 1) % this.referenceDelay;
        if (++this.frameAt === this.frameSize) {
          this.aec.analyze([this.referenceFrame]);
          this.aec.process([this.processedFrame], [this.inputFrame]);
          for (let j = 0; j < 480; j++) {
            this.queue[this.writeAt] = this.processedFrame[j];
            this.writeAt = (this.writeAt + 1) % 960;
          }
          this.queued += 480; this.frameAt = 0;
        }
      }
    } catch {
      output.fill(0); this.enabled = false;
      this.port.postMessage({type:'error'});
    }
    return this.alive;
  }
}
registerProcessor('elf-ptt-aec3', ElfPttAecProcessor);
