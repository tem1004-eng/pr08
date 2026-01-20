
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, Square, Trash2, FileText, AlertCircle, Music, FileJson, Clock, RefreshCw, Zap, AlignLeft, Monitor, Smartphone, Volume2, Youtube, Film, FileAudio, ExternalLink, Upload, PlayCircle, Sparkles, Play } from 'lucide-react';
import { GoogleGenAI, Modality } from '@google/genai';
import { downloadTextFile, downloadAudioFile, formatDuration } from './utils/fileUtils';
import Visualizer from './components/Visualizer';
import { AudioMetadata } from './types';

// 오디오 인코딩 유틸리티 (PCM 16-bit to Base64)
const encode = (bytes: Uint8Array) => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

// 유튜브 ID 추출 유틸리티
const extractYoutubeId = (url: string) => {
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[7].length === 11) ? match[7] : null;
};

type SourceMode = 'mic' | 'youtube' | 'video' | 'audio';

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioData, setAudioData] = useState<AudioMetadata | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [transcribedText, setTranscribedText] = useState<string>('');
  const [sourceMode, setSourceMode] = useState<SourceMode>('mic');
  const [isMobile, setIsMobile] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeId, setYoutubeId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<any>(null);
  const textEndRef = useRef<HTMLDivElement>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const fileAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playerRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setIsMobile(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
    return () => stopRecording();
  }, []);

  useEffect(() => {
    if (textEndRef.current) {
      textEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcribedText]);

  const requestWakeLock = async () => {
    if ('wakeLock' in navigator && (navigator as any).wakeLock) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      } catch (err) {}
    }
  };

  const stopRecording = useCallback(() => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (fileAudioSourceRef.current) {
        fileAudioSourceRef.current.stop();
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      
      setIsRecording(false);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      sessionPromiseRef.current = null;
      setStream(null);
    }
  }, [isRecording]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleYoutubeLoad = () => {
    const id = extractYoutubeId(youtubeUrl);
    if (id) {
      setYoutubeId(id);
    } else {
      alert("올바른 유튜브 주소를 입력해주세요.");
    }
  };

  const startConversion = async () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    try {
      let captureStream: MediaStream | null = null;
      let audioBuffer: AudioBuffer | null = null;
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      // 1. 소스에 따른 오디오 스트림 설정
      if (sourceMode === 'mic') {
        captureStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } else if (sourceMode === 'youtube') {
        if (!youtubeId) {
            alert("유튜브 영상을 먼저 불러와주세요.");
            audioCtx.close();
            return;
        }
        
        // 브라우저 탭 공유 오디오 캡처 안내
        alert("팝업창에서 '이 탭'을 선택하고 '시스템 오디오 공유'를 반드시 체크해주세요. 확인을 누르면 공유 창이 뜹니다.");
        
        captureStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1 },
          audio: { echoCancellation: false, noiseSuppression: false }
        });
      } else if (sourceMode === 'audio' || sourceMode === 'video') {
        if (!selectedFile) {
          alert("먼저 변환할 파일을 선택해주세요.");
          audioCtx.close();
          return;
        }
        const arrayBuffer = await selectedFile.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      }

      setStream(captureStream);
      setTranscribedText('');
      setRecordingTime(0);

      // 2. Gemini Live API 연결
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `너는 오디오 실시간 받아쓰기 전문가야. ${sourceMode === 'youtube' ? '유튜브 강의 영상' : sourceMode === 'audio' || sourceMode === 'video' ? '업로드된 미디어 파일' : '마이크 대화'}의 내용을 실시간으로 듣고 정확하게 한국어 텍스트로 변환해줘. 문맥을 파악해서 읽기 좋게 다듬어주고, 들리는 즉시 출력해.`
        },
        callbacks: {
          onmessage: async (message) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setTranscribedText(prev => prev + text);
            }
          },
          onerror: (e) => console.error("Gemini Live Error:", e),
          onclose: () => stopRecording()
        }
      });
      sessionPromiseRef.current = sessionPromise;

      // 3. 오디오 데이터 스트리밍 처리
      const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const l = inputData.length;
        const int16 = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          int16[i] = inputData[i] * 32768; 
        }
        const base64Data = encode(new Uint8Array(int16.buffer));
        sessionPromiseRef.current?.then(session => {
          session.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        });
      };

      if (captureStream) {
        const source = audioCtx.createMediaStreamSource(captureStream);
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioCtx.destination);

        const mediaRecorder = new MediaRecorder(captureStream);
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: 'audio/mp3' });
          const url = URL.createObjectURL(blob);
          setAudioData({ blob, url, duration: recordingTime });
          downloadAudioFile(blob, `필통_${sourceMode}_${formatDuration(recordingTime)}.mp3`);
        };
        mediaRecorder.start();
      } else if (audioBuffer) {
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioCtx.destination);
        source.connect(audioCtx.destination); 
        fileAudioSourceRef.current = source;
        source.start();
        source.onended = () => stopRecording();
      }

      setIsRecording(true);
      await requestWakeLock();
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("변환 시작 실패:", err);
      alert("변환을 시작할 수 없습니다. '시스템 오디오 공유'를 체크했는지 확인해주세요.");
    }
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] flex flex-col items-center p-4 sm:p-6 md:p-10">
      <header className="w-full max-w-3xl mt-4 mb-8 text-center">
        <div className="inline-flex items-center gap-2 bg-white px-5 py-2 rounded-full shadow-sm mb-4 border border-slate-100">
          <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-blue-600'}`}></div>
          <span className="text-[11px] font-black text-slate-600 uppercase tracking-[0.2em]">Piltong Ai-Transcriber Pro</span>
        </div>
        <h1 className="text-5xl md:text-6xl font-black text-slate-900 tracking-tighter">
          필통 <span className="text-blue-600">녹음기 PRO</span>
        </h1>
        <p className="text-slate-400 font-bold text-sm mt-4 uppercase tracking-tighter">유튜브 강의부터 내 목소리까지 실시간 변환</p>
      </header>

      <main className="w-full max-w-4xl bg-white rounded-[60px] shadow-2xl shadow-blue-900/10 border border-white overflow-hidden flex flex-col relative transition-all duration-500">
        
        {/* 모드 선택 (상단 탭) */}
        <div className="grid grid-cols-4 gap-2 p-5 bg-slate-50/80 border-b border-slate-100">
          <button 
            disabled={isRecording}
            onClick={() => { setSourceMode('mic'); setSelectedFile(null); }}
            className={`py-5 rounded-[28px] flex flex-col items-center gap-2 font-black text-[10px] transition-all transform hover:scale-105 active:scale-95 ${sourceMode === 'mic' ? 'bg-white shadow-xl text-blue-600 border border-blue-50' : 'text-slate-400 opacity-60'}`}
          >
            <Mic className="w-6 h-6" />
            마이크
          </button>
          <button 
            disabled={isRecording}
            onClick={() => { setSourceMode('youtube'); setSelectedFile(null); }}
            className={`py-5 rounded-[28px] flex flex-col items-center gap-2 font-black text-[10px] transition-all transform hover:scale-105 active:scale-95 ${sourceMode === 'youtube' ? 'bg-white shadow-xl text-red-600 border border-red-50' : 'text-slate-400 opacity-60'}`}
          >
            <Youtube className="w-6 h-6" />
            유튜브
          </button>
          <button 
            disabled={isRecording}
            onClick={() => { setSourceMode('video'); setSelectedFile(null); }}
            className={`py-5 rounded-[28px] flex flex-col items-center gap-2 font-black text-[10px] transition-all transform hover:scale-105 active:scale-95 ${sourceMode === 'video' ? 'bg-white shadow-xl text-indigo-600 border border-indigo-50' : 'text-slate-400 opacity-60'}`}
          >
            <Film className="w-6 h-6" />
            동영상
          </button>
          <button 
            disabled={isRecording}
            onClick={() => { setSourceMode('audio'); setSelectedFile(null); }}
            className={`py-5 rounded-[28px] flex flex-col items-center gap-2 font-black text-[10px] transition-all transform hover:scale-105 active:scale-95 ${sourceMode === 'audio' ? 'bg-white shadow-xl text-emerald-600 border border-emerald-50' : 'text-slate-400 opacity-60'}`}
          >
            <FileAudio className="w-6 h-6" />
            음성파일
          </button>
        </div>

        {/* 설정 영역 (입력 및 미리보기) */}
        <div className="px-10 pt-10 flex flex-col gap-6">
          {sourceMode === 'youtube' && (
            <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-top-4">
              <div className="flex flex-col gap-2">
                <p className="text-xs font-black text-slate-400 uppercase tracking-widest px-2">유튜브 강의 주소 입력</p>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder="https://www.youtube.com/watch?v=..." 
                    className="flex-1 px-6 py-4 rounded-3xl bg-slate-50 border border-slate-100 text-sm focus:ring-4 ring-blue-50 outline-none font-medium transition-all"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleYoutubeLoad()}
                  />
                  <button 
                    onClick={handleYoutubeLoad} 
                    className="px-6 bg-blue-600 text-white rounded-3xl hover:bg-blue-700 transition-colors flex items-center gap-2 font-bold text-sm shadow-lg shadow-blue-100"
                  >
                    <ExternalLink className="w-4 h-4" />
                    불러오기
                  </button>
                </div>
              </div>

              {youtubeId && (
                <div className="relative aspect-video w-full max-w-2xl mx-auto rounded-[32px] overflow-hidden border-8 border-slate-50 shadow-inner group">
                   <iframe
                    ref={playerRef}
                    className="w-full h-full"
                    src={`https://www.youtube.com/embed/${youtubeId}?enablejsapi=1&autoplay=1&mute=0`}
                    title="YouTube video player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                  ></iframe>
                </div>
              )}
            </div>
          )}
          
          {(sourceMode === 'audio' || sourceMode === 'video') && (
            <div className="animate-in fade-in slide-in-from-top-4">
              <p className="text-xs font-black text-slate-400 uppercase tracking-widest px-2 mb-3">미디어 파일 선택</p>
              <label className="group flex flex-col items-center justify-center gap-4 w-full p-10 border-4 border-dashed border-slate-100 rounded-[40px] cursor-pointer hover:bg-slate-50 hover:border-blue-100 transition-all">
                <div className={`p-4 rounded-2xl ${sourceMode === 'video' ? 'bg-indigo-50 text-indigo-500' : 'bg-emerald-50 text-emerald-500'} group-hover:scale-110 transition-transform`}>
                  <Upload className="w-8 h-8" />
                </div>
                <div className="text-center">
                  <p className="font-black text-slate-600 text-base">
                    {selectedFile ? selectedFile.name : `변환할 ${sourceMode === 'video' ? '동영상' : '음성'} 파일을 선택하세요`}
                  </p>
                  <p className="text-[10px] text-slate-400 font-bold uppercase mt-1 tracking-tighter">드래그하거나 클릭하여 파일을 올려주세요</p>
                </div>
                <input type="file" className="hidden" accept={sourceMode === 'video' ? 'video/*' : 'audio/*'} onChange={handleFileChange} />
              </label>
            </div>
          )}

          {/* 메인 변환 버튼 */}
          <div className="animate-in fade-in zoom-in duration-700">
            <button
              onClick={startConversion}
              disabled={
                ((sourceMode === 'audio' || sourceMode === 'video') && !selectedFile) ||
                (sourceMode === 'youtube' && !youtubeId)
              }
              className={`w-full py-8 rounded-[40px] font-black flex items-center justify-center gap-4 transition-all text-3xl shadow-2xl transform active:scale-95 ${
                isRecording 
                  ? 'bg-red-500 text-white animate-pulse ring-8 ring-red-50' 
                  : ((sourceMode === 'audio' || sourceMode === 'video') && !selectedFile) || (sourceMode === 'youtube' && !youtubeId)
                    ? 'bg-slate-100 text-slate-300 cursor-not-allowed shadow-none'
                    : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-200 hover:-translate-y-1 ring-8 ring-blue-50/50'
              }`}
            >
              {isRecording ? <Square className="w-8 h-8 fill-current" /> : <Sparkles className="w-8 h-8 fill-current" />}
              {isRecording ? '변환 중지하기' : '텍스트로 변환'}
            </button>
            <p className="text-center text-[10px] font-bold text-slate-400 mt-4 uppercase tracking-tighter">
                {sourceMode === 'youtube' ? "* 팁: 공유 창에서 '이 탭'을 선택하고 '오디오 공유'를 꼭 체크해주세요." : "버튼을 누르면 즉시 변환이 시작됩니다."}
            </p>
          </div>
        </div>

        <div className="p-10 md:p-14 flex flex-col items-center">
          <div className="text-center w-full mb-8">
            <div className={`text-8xl md:text-9xl font-mono font-black tracking-tighter mb-4 transition-colors duration-500 ${isRecording ? 'text-red-500' : 'text-slate-900'}`}>
              {formatDuration(recordingTime)}
            </div>
            {isRecording && (
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center gap-3 bg-blue-50 px-6 py-3 rounded-full text-blue-600 font-black text-xs uppercase animate-pulse border border-blue-100">
                  <Zap className="w-4 h-4 fill-current" />
                  <span>Gemini Native AI 가 강의를 실시간 번역 중</span>
                </div>
              </div>
            )}
          </div>
          <Visualizer stream={stream} isRecording={isRecording} />
        </div>

        {/* 실시간 텍스트 뷰어 */}
        <div className="px-8 pb-8 md:px-14 md:pb-14">
          <div className={`bg-slate-50/50 rounded-[48px] p-10 border transition-all duration-700 relative overflow-hidden ${isRecording ? 'border-blue-200 shadow-2xl shadow-blue-50 ring-8 ring-blue-50/50' : 'border-slate-100 shadow-inner'}`}>
            {isRecording && <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-shimmer"></div>}
            
            <div className="flex items-center justify-between mb-8 border-b border-slate-200 pb-6">
              <div className="flex items-center gap-4">
                <div className="p-3 bg-blue-600 rounded-2xl shadow-lg shadow-blue-200">
                    <AlignLeft className="w-6 h-6 text-white" />
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Real-time Transcription Viewer</span>
                  <span className="text-[10px] text-blue-500 font-bold uppercase mt-1">Source: {sourceMode.toUpperCase()}</span>
                </div>
              </div>
              {isRecording && (
                <div className="flex items-center gap-4">
                    <Volume2 className="w-5 h-5 text-blue-500 animate-bounce" />
                    <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />
                </div>
              )}
            </div>

            <div className="h-96 md:h-[500px] overflow-y-auto text-slate-800 text-xl md:text-2xl leading-[1.8] font-semibold scroll-smooth scrollbar-hide px-2">
              {transcribedText ? (
                <div className="whitespace-pre-wrap animate-in fade-in duration-500">
                  {transcribedText}
                  <div ref={textEndRef} className="h-10" />
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-200 italic opacity-40">
                  <FileText className="w-24 h-24 mb-6" />
                  <p className="text-sm font-black uppercase tracking-[0.3em]">강의 소리가 들리면 즉시 받아적습니다</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-12 flex flex-col gap-6">
            <button
              onClick={() => downloadTextFile(transcribedText, `필통변환_${sourceMode}_${formatDuration(recordingTime)}.txt`)}
              disabled={!transcribedText || isRecording}
              className={`w-full py-8 rounded-[40px] font-black flex items-center justify-center gap-4 transition-all text-2xl shadow-2xl transform active:scale-95 ${
                !transcribedText || isRecording
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed shadow-none'
                  : 'bg-amber-400 text-white hover:bg-amber-500 shadow-amber-200 hover:-translate-y-1'
              }`}
            >
              <FileJson className="w-9 h-9" />
              텍스트 파일로 내려받기
            </button>
          </div>
        </div>
      </main>

      <footer className="mt-16 text-slate-300 text-[11px] font-black uppercase tracking-[0.6em] text-center mb-10">
        PILTONG PRO • POWERED BY GOOGLE GEMINI 2.5
      </footer>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .animate-shimmer {
          animation: shimmer 2s infinite linear;
        }
      `}</style>
    </div>
  );
};

export default App;
