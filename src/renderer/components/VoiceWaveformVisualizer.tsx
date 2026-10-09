import React from "react";

export interface VoiceWaveformVisualizerProps {
  stream: MediaStream | null;
  isRecording: boolean;
  isTranscribing: boolean;
}

export function VoiceWaveformVisualizer({ stream, isRecording, isTranscribing }: VoiceWaveformVisualizerProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;

    if (stream && isRecording && !isTranscribing) {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          audioCtx = new AudioContextClass();
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 64; // 32 frequency buckets
          analyser.smoothingTimeConstant = 0.8;
          source = audioCtx.createMediaStreamSource(stream);
          source.connect(analyser);
        }
      } catch (err) {
        console.warn("[VoiceWaveform] Web Audio API indisponível ou permissão pendente:", err);
      }
    }

    const dataArray = analyser ? new Uint8Array(analyser.frequencyBinCount) : new Uint8Array(32);
    let step = 0;

    const render = () => {
      if (!canvasRef.current) return;
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      step++;

      if (isTranscribing) {
        // Modo Processamento / Transcrição com IA: ondas sincronizadas elegantes em movimento progressivo
        const barCount = 38;
        const gap = 3;
        const barWidth = Math.max(3, (width - (barCount - 1) * gap) / barCount);
        const centerY = height / 2;

        for (let i = 0; i < barCount; i++) {
          const wave = Math.sin((step * 0.08) + (i * 0.22)) * 0.5 + 0.5;
          const barHeight = Math.max(4, wave * (height * 0.7));
          const x = i * (barWidth + gap);
          const y = centerY - barHeight / 2;

          const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
          grad.addColorStop(0, "#c084fc");
          grad.addColorStop(0.5, "#a855f7");
          grad.addColorStop(1, "#7c3aed");

          ctx.fillStyle = grad;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, barWidth, barHeight, 2);
          } else {
            ctx.rect(x, y, barWidth, barHeight);
          }
          ctx.fill();
        }
      } else {
        // Modo Gravação Ativa: análise de amplitude e frequências em tempo real do microfone
        if (analyser) {
          analyser.getByteFrequencyData(dataArray);
        }

        const barCount = 38;
        const gap = 3;
        const barWidth = Math.max(3, (width - (barCount - 1) * gap) / barCount);
        const centerY = height / 2;

        for (let i = 0; i < barCount; i++) {
          // Espelhamento simétrico a partir do centro (padrão de assistentes modernos)
          const centerDist = Math.abs(i - barCount / 2);
          const freqIndex = Math.min(
            dataArray.length - 1,
            Math.floor((1 - (centerDist / (barCount / 2))) * (dataArray.length - 1))
          );
          const rawValue = dataArray[freqIndex] || 0; // 0 a 255
          const normAmp = rawValue / 255;

          // Se em silêncio: micro pulso sutil de base (~3.5px a 5px) sem indicar falsa fala
          const idleWave = Math.sin((step * 0.04) + (i * 0.3)) * 1.2;
          const minHeight = 4 + Math.max(0, idleWave);
          const activeHeight = normAmp * (height * 0.85);
          const barHeight = Math.max(minHeight, activeHeight);

          const x = i * (barWidth + gap);
          const y = centerY - barHeight / 2;

          // Gradiente vibrante NekoAI
          const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
          if (normAmp > 0.45) {
            grad.addColorStop(0, "#38bdf8"); // Toque ciano nos picos vocais
            grad.addColorStop(0.3, "#c084fc");
            grad.addColorStop(1, "#9333ea");
          } else {
            grad.addColorStop(0, "#c084fc");
            grad.addColorStop(0.6, "#a855f7");
            grad.addColorStop(1, "#581c87");
          }

          ctx.fillStyle = grad;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, barWidth, barHeight, 2);
          } else {
            ctx.rect(x, y, barWidth, barHeight);
          }
          ctx.fill();
        }
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (source) {
        try { source.disconnect(); } catch {}
      }
      if (audioCtx) {
        try { audioCtx.close().catch(() => {}); } catch {}
      }
    };
  }, [stream, isRecording, isTranscribing]);

  return (
    <div className="voice-waveform-container" role="img" aria-label="Visualizador de ondas de áudio">
      <canvas
        ref={canvasRef}
        width={460}
        height={52}
        className="voice-waveform-canvas"
      />
    </div>
  );
}
