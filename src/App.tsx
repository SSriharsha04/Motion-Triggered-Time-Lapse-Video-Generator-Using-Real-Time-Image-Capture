import React, { useEffect, useRef, useState } from 'react';
import { Camera, Bell, Video, Settings, AlertTriangle, Play, Flame } from 'lucide-react';

interface DetectionState {
  isActive: boolean;
  motionDetected: boolean;
  fireDetected: boolean;
}

interface CapturedFrame {
  dataUrl: string;
  timestamp: number;
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousFrameRef = useRef<ImageData | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const [detection, setDetection] = useState<DetectionState>({
    isActive: false,
    motionDetected: false,
    fireDetected: false,
  });
  const [error, setError] = useState<string>('');
  const [capturedFrames, setCapturedFrames] = useState<CapturedFrame[]>([]);
  const [sensitivity, setSensitivity] = useState(30);
  const detectionIntervalRef = useRef<number | undefined>(); // Fixed: Removed NodeJS.Timeout
  const lastCaptureTimeRef = useRef(0);
  const CAPTURE_COOLDOWN = 1000;

  const startAlarm = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (oscillatorRef.current) return;

    const audioContext = audioContextRef.current;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(440, audioContext.currentTime);

    const now = audioContext.currentTime;
    gainNode.gain.setValueAtTime(1, now);
    gainNode.gain.setValueAtTime(0, now + 0.2);
    gainNode.gain.setValueAtTime(1, now + 0.4);
    gainNode.gain.setValueAtTime(0, now + 0.6);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start();
    oscillatorRef.current = oscillator;
  };

  const stopAlarm = () => {
    if (oscillatorRef.current) {
      oscillatorRef.current.stop();
      oscillatorRef.current.disconnect();
      oscillatorRef.current = null;
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          setDetection(prev => ({ ...prev, isActive: true }));
          detectionIntervalRef.current = setInterval(detectMotion, 100);
        };
      }
      setError('');
    } catch (err) {
      setError('Failed to access camera. Please ensure camera permissions are granted.');
    }
  };

  const stopCamera = () => {
    if (videoRef.current?.srcObject) {
      const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
      tracks.forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = undefined;
    }
    stopAlarm();
    setDetection(prev => ({ ...prev, isActive: false, motionDetected: false, fireDetected: false }));
  };

  const captureFrame = (): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 1.0);
  };

  const detectFire = (imageData: ImageData): boolean => {
    const data = imageData.data;
    let firePixels = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (r > 200 && g < 140 && b < 40) {
        firePixels++;
      }
    }

    const totalPixels = imageData.width * imageData.height;
    const firePercentage = (firePixels / totalPixels) * 100;
    return firePercentage > 1;
  };

  const detectMotion = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const currentFrame = context.getImageData(0, 0, canvas.width, canvas.height);
    const fireDetected = detectFire(currentFrame);

    setDetection(prev => {
      if (fireDetected && !prev.fireDetected) startAlarm();
      else if (!fireDetected && prev.fireDetected) stopAlarm();
      return { ...prev, fireDetected };
    });

    if (previousFrameRef.current) {
      const previousFrame = previousFrameRef.current;
      let diffCount = 0;

      for (let i = 0; i < currentFrame.data.length; i += 4) {
        const diff = Math.abs(currentFrame.data[i] - previousFrame.data[i]) +
          Math.abs(currentFrame.data[i + 1] - previousFrame.data[i + 1]) +
          Math.abs(currentFrame.data[i + 2] - previousFrame.data[i + 2]);

        if (diff > 100) diffCount++;
      }

      const totalPixels = canvas.width * canvas.height;
      const diffPercentage = (diffCount / totalPixels) * 100;
      const motionDetected = diffPercentage > (100 - sensitivity) / 3;

      setDetection(prev => ({ ...prev, motionDetected }));

      if ((motionDetected || fireDetected) && Date.now() - lastCaptureTimeRef.current > CAPTURE_COOLDOWN) {
        const frameDataUrl = captureFrame();
        if (frameDataUrl) {
          setCapturedFrames(prev => [...prev, {
            dataUrl: frameDataUrl,
            timestamp: Date.now()
          }]);
          lastCaptureTimeRef.current = Date.now();
        }
      }
    }

    previousFrameRef.current = currentFrame;
  };

  const createTimelapse = () => {
    if (capturedFrames.length < 2) {
      setError('Not enough frames captured for timelapse');
      return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set initial canvas size based on the first frame
    const firstImage = new Image();
    firstImage.onload = () => {
      canvas.width = firstImage.width;
      canvas.height = firstImage.height;

      // Initialize MediaRecorder with explicit codec
      const stream = canvas.captureStream(25); // 25 FPS
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9', // Explicitly use VP9 codec
      });
      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timelapse-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
      };

      let currentFrame = 0;
      const frameDuration = 100; // 100ms per frame (10 FPS)

      const drawNextFrame = () => {
        if (currentFrame >= capturedFrames.length) {
          mediaRecorder.stop();
          return;
        }

        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          currentFrame++;
          setTimeout(drawNextFrame, frameDuration);
        };
        img.onerror = () => {
          console.error(`Failed to load frame ${currentFrame}`);
          currentFrame++;
          setTimeout(drawNextFrame, frameDuration);
        };
        img.src = capturedFrames[currentFrame].dataUrl;
      };

      // Start recording after a slight delay to ensure stream is ready
      mediaRecorder.start();
      setTimeout(() => drawNextFrame(), 100); // Small delay to ensure recording begins
    };
    firstImage.onerror = () => console.error('Failed to load first frame');
    firstImage.src = capturedFrames[0].dataUrl;
  };

  const toggleDetection = () => {
    if (!detection.isActive) {
      startCamera();
    } else {
      stopCamera();
      setCapturedFrames([]);
    }
  };

  useEffect(() => {
    return () => {
      stopCamera();
      stopAlarm();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-gray-800 p-4">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Camera className="h-6 w-6 text-blue-400" />
            <h1 className="text-xl font-bold">Security Monitor</h1>
          </div>
          <div className="flex items-center space-x-4">
            <button
              onClick={createTimelapse}
              disabled={capturedFrames.length < 2}
              className={`px-4 py-2 rounded-lg font-medium ${capturedFrames.length < 2
                ? 'bg-gray-600 cursor-not-allowed'
                : 'bg-blue-500 hover:bg-blue-600'
                } transition-colors flex items-center space-x-2`}
            >
              <Play className="h-4 w-4" />
              <span>Create Timelapse</span>
            </button>
            <button
              onClick={toggleDetection}
              className={`px-4 py-2 rounded-lg font-medium ${detection.isActive
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-green-500 hover:bg-green-600'
                } transition-colors`}
            >
              {detection.isActive ? 'Stop Monitoring' : 'Start Monitoring'}
            </button>
          </div>
        </div>
      </header>

      <main className="container mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-gray-800 rounded-lg p-4">
            <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />

              {error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-75">
                  <div className="text-center p-4">
                    <AlertTriangle className="h-12 w-12 text-yellow-500 mx-auto mb-2" />
                    <p className="text-red-400">{error}</p>
                  </div>
                </div>
              )}

              {detection.fireDetected && (
                <div className="absolute top-4 right-4 bg-red-500 text-white px-4 py-2 rounded-lg flex items-center space-x-2 animate-pulse">
                  <Flame className="h-5 w-5" />
                  <span className="font-bold">Fire Detected!</span>
                </div>
              )}
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-lg font-semibold mb-4">Monitoring Status</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-gray-700 rounded-lg">
                <div className="flex items-center space-x-2">
                  <Bell className="h-5 w-5 text-blue-400" />
                  <span>Motion Detection</span>
                </div>
                <div className={`h-3 w-3 rounded-full ${detection.motionDetected ? 'bg-red-500' : 'bg-green-500'}`} />
              </div>

              <div className="flex items-center justify-between p-3 bg-gray-700 rounded-lg">
                <div className="flex items-center space-x-2">
                  <Flame className="h-5 w-5 text-orange-400" />
                  <span>Fire Detection</span>
                </div>
                <div className={`h-3 w-3 rounded-full ${detection.fireDetected ? 'bg-red-500' : 'bg-green-500'}`} />
              </div>

              <div className="flex items-center justify-between p-3 bg-gray-700 rounded-lg">
                <div className="flex items-center space-x-2">
                  <Video className="h-5 w-5 text-purple-400" />
                  <span>Captured Frames</span>
                </div>
                <span className="text-sm font-medium">{capturedFrames.length}</span>
              </div>

              <div className="flex items-center justify-between p-3 bg-gray-700 rounded-lg">
                <div className="flex items-center space-x-2">
                  <Video className="h-5 w-5 text-purple-400" />
                  <span>Recording Status</span>
                </div>
                <div className={`h-3 w-3 rounded-full ${detection.isActive ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`} />
              </div>
            </div>

            <div className="mt-6">
              <div className="flex items-center space-x-2 mb-4">
                <Settings className="h-5 w-5 text-gray-400" />
                <h3 className="text-lg font-semibold">Settings</h3>
              </div>
              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm">Motion Sensitivity</label>
                    <span className="text-sm text-gray-400">{sensitivity}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;