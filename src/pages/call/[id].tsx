import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import { getMatchmakingStatus, updatePeerId } from '../../utils/api';
import { useAuth } from '../../contexts/AuthContext';
import Peer, { MediaConnection } from 'peerjs';

export default function CallPage() {
    const router = useRouter();
    const { id: sessionId } = router.query;
    const { user } = useAuth();
    const [timeLeft, setTimeLeft] = useState(3600); // 1 hour in seconds
    const [error, setError] = useState<string | null>(null);
    const [connectionStatus, setConnectionStatus] = useState('Initializing...');

    // PeerJS states
    const [peer, setPeer] = useState<Peer | null>(null);
    const [currentCall, setCurrentCall] = useState<MediaConnection | null>(null);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);

    // Add state for partner's peer ID
    const [partnerPeerId, setPartnerPeerId] = useState<string | null>(null);

    // Add state for remote user's media status
    const [remoteIsMuted, setRemoteIsMuted] = useState(false);
    const [remoteIsVideoOff, setRemoteIsVideoOff] = useState(false);

    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);

    // Add at the start of the component
    useEffect(() => {
        console.log('Component mounted with:', {
            sessionId,
            userId: user?.uid,
            connectionStatus,
            hasPeer: !!peer,
            hasCurrentCall: !!currentCall
        });
    }, []);

    // Initialize peer connection
    useEffect(() => {
        if (!user || !sessionId) return;

        const initializePeer = () => {
            console.log('Initializing peer with session:', sessionId);
            const randomSuffix = Math.random().toString(36).substring(2, 15);
            const myPeerId = `${sessionId}-${user.uid}-${randomSuffix}`;
            console.log('Generated peer ID:', myPeerId);

            const newPeer = new Peer(myPeerId, {
                host: '0.peerjs.com',
                port: 443,
                path: '/',
                secure: true,
                debug: 3,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            // Set up media stream early
            const setupMediaStream = async () => {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        video: true,
                        audio: true
                    });
                    setLocalStream(stream);
                    if (localVideoRef.current) {
                        localVideoRef.current.srcObject = stream;
                    }
                    return stream;
                } catch (err) {
                    console.error('Failed to get local stream:', err);
                    setError('Failed to access camera/microphone');
                    return null;
                }
            };

            newPeer.on('open', async () => {
                console.log('Peer connection opened:', myPeerId);
                setPeer(newPeer);
                setConnectionStatus('Connected to server');

                // Set up local media stream
                const stream = await setupMediaStream();
                if (!stream) return;

                try {
                    console.log('Storing peer ID via API...');
                    await updatePeerId(sessionId as string, myPeerId);
                    console.log('Successfully stored peer ID');

                    const attemptConnection = async () => {
                        console.log('Checking for partner peer ID...');
                        const status = await getMatchmakingStatus();
                        console.log('Status response:', status);

                        if (status.partnerId && status.peerIds?.[status.partnerId]) {
                            const partnerPeerId = status.peerIds[status.partnerId];
                            console.log('Partner peer ID found:', partnerPeerId);
                            setPartnerPeerId(partnerPeerId);

                            // Both peers try to call each other, but only the first successful call will be established
                            if (!currentCall) {
                                try {
                                    console.log('Attempting to initiate call to:', partnerPeerId);
                                    const call = newPeer.call(partnerPeerId, stream);
                                    setupCallHandlers(call);
                                } catch (error) {
                                    console.error('Call initiation failed:', error);
                                }
                            }
                        } else {
                            console.log('No partner peer ID yet, retrying in 1s');
                            setTimeout(attemptConnection, 1000);
                        }
                    };

                    attemptConnection();
                } catch (error) {
                    console.error('Peer setup failed:', error);
                    setError('Failed to connect with partner');
                }
            });

            newPeer.on('call', async (call) => {
                console.log('Received incoming call from:', call.peer);
                const stream = localStream || await setupMediaStream();
                if (!stream) return;

                if (!currentCall) {
                    console.log('Answering incoming call');
                    call.answer(stream);
                    setupCallHandlers(call);
                } else {
                    console.log('Already in a call, ignoring incoming call');
                }
            });

            newPeer.on('error', (error) => {
                console.error('Peer error:', { type: error.type, message: error.message });
                if (error.type === 'unavailable-id') {
                    console.log('Retrying with new peer ID...');
                    initializePeer();
                } else {
                    setError(`Connection error: ${error.type}`);
                }
            });

            newPeer.on('disconnected', () => {
                console.log('Peer disconnected, attempting reconnect');
                setConnectionStatus('Disconnected - Attempting to reconnect...');
                newPeer.reconnect();
            });

            setPeer(newPeer);
        };

        const setupCallHandlers = (call: MediaConnection) => {
            setCurrentCall(call);
            setConnectionStatus('Call connecting...');

            call.on('stream', (remoteStream) => {
                console.log('Received remote stream');
                if (remoteVideoRef.current) {
                    remoteVideoRef.current.srcObject = remoteStream;
                    setConnectionStatus('Connected');

                    // Track remote media status changes
                    remoteStream.getAudioTracks().forEach(track => {
                        track.onmute = () => setRemoteIsMuted(true);
                        track.onunmute = () => setRemoteIsMuted(false);
                        setRemoteIsMuted(!track.enabled);
                    });

                    remoteStream.getVideoTracks().forEach(track => {
                        track.onmute = () => setRemoteIsVideoOff(true);
                        track.onunmute = () => setRemoteIsVideoOff(false);
                        setRemoteIsVideoOff(!track.enabled);
                    });
                }
            });

            call.on('error', (err) => {
                console.error('Call error:', err);
                setError('Call connection failed');
                cleanupMedia();
            });

            call.on('close', () => {
                console.log('Call closed');
                setConnectionStatus('Call ended');
                cleanupMedia();
            });
        };

        initializePeer();

        return () => {
            console.log('Component unmounting, cleaning up...');
            cleanupMedia();
            if (sessionId && user) {
                console.log('Removing peer ID via API');
                updatePeerId(sessionId as string, null).catch(error =>
                    console.error('Failed to remove peer ID:', error)
                );
            }
        };
    }, [user, sessionId]);

    // Session timer and verification
    useEffect(() => {
        if (!user || !sessionId) return;

        const checkSession = async () => {
            try {
                const status = await getMatchmakingStatus();

                if (status.status !== 'in_session' || status.sessionId !== sessionId) {
                    router.push('/');
                    return;
                }

                if (status.timeLeft) {
                    setTimeLeft(Math.floor(status.timeLeft / 1000));
                }
            } catch (error) {
                console.error('Session check failed:', error);
                setError('Failed to verify session');
            }
        };

        const interval = setInterval(checkSession, 5000);
        checkSession();

        return () => clearInterval(interval);
    }, [sessionId, user, router]);

    // Timer effect
    useEffect(() => {
        if (timeLeft <= 0) {
            cleanupMedia();
            router.push(`/chat/${sessionId}`);
        } else {
            const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
            return () => clearTimeout(timer);
        }
    }, [timeLeft, sessionId, router]);

    const cleanupMedia = () => {
        console.log('Cleaning up media...', {
            hasLocalStream: !!localStream,
            hasCurrentCall: !!currentCall,
            hasPeer: !!peer
        });
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            setLocalStream(null);
        }
        if (currentCall) {
            currentCall.close();
            setCurrentCall(null);
        }
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = null;
        }
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }
        if (peer) {
            peer.destroy();
        }
    };

    const toggleMute = () => {
        if (localStream) {
            localStream.getAudioTracks().forEach(track => {
                track.enabled = !track.enabled;
            });
            setIsMuted(!isMuted);
        }
    };

    const toggleVideo = () => {
        if (localStream) {
            localStream.getVideoTracks().forEach(track => {
                track.enabled = !track.enabled;
            });
            setIsVideoOff(!isVideoOff);
        }
    };

    return (
        <Layout>
            <div className="min-h-[calc(100vh-4rem)] grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                <div className="relative bg-gray-900 rounded-lg overflow-hidden">
                    <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className={`aspect-video w-full bg-gray-800 ${isVideoOff ? 'invisible' : 'visible'}`}
                    />
                    {isVideoOff && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                            <div className="text-gray-400">Camera Off</div>
                        </div>
                    )}
                    <div className="absolute top-4 left-4 flex gap-2">
                        {isMuted && (
                            <div className="bg-red-500/80 text-white px-2 py-1 rounded-full text-sm flex items-center gap-1">
                                <MicIcon muted />
                                Muted
                            </div>
                        )}
                        {isVideoOff && (
                            <div className="bg-red-500/80 text-white px-2 py-1 rounded-full text-sm flex items-center gap-1">
                                <CameraIcon disabled />
                                Camera Off
                            </div>
                        )}
                    </div>
                    <div className="absolute bottom-4 right-4 flex gap-2">
                        <button
                            onClick={toggleMute}
                            className={`p-2 rounded-full ${isMuted ? 'bg-red-500' : 'bg-gray-800'} hover:bg-gray-700 text-white transition-colors`}
                            title={isMuted ? "Unmute" : "Mute"}
                        >
                            <MicIcon muted={isMuted} />
                        </button>
                        <button
                            onClick={toggleVideo}
                            className={`p-2 rounded-full ${isVideoOff ? 'bg-red-500' : 'bg-gray-800'} hover:bg-gray-700 text-white transition-colors`}
                            title={isVideoOff ? "Turn Camera On" : "Turn Camera Off"}
                        >
                            <CameraIcon disabled={isVideoOff} />
                        </button>
                    </div>
                </div>

                <div className="relative bg-gray-900 rounded-lg overflow-hidden">
                    <video
                        ref={remoteVideoRef}
                        autoPlay
                        playsInline
                        className={`aspect-video w-full bg-gray-800 ${remoteIsVideoOff ? 'invisible' : 'visible'}`}
                    />
                    {remoteIsVideoOff && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                            <div className="text-gray-400">Camera Off</div>
                        </div>
                    )}
                    <div className="absolute top-4 left-4 flex gap-2">
                        <div className={`text-sm px-3 py-1 rounded-full ${error
                            ? 'bg-red-500/80 text-white'
                            : 'bg-black/50 text-white'
                            }`}>
                            {error || connectionStatus}
                        </div>
                        {remoteIsMuted && (
                            <div className="bg-red-500/80 text-white px-2 py-1 rounded-full text-sm flex items-center gap-1">
                                <MicIcon muted />
                                Muted
                            </div>
                        )}
                        {remoteIsVideoOff && (
                            <div className="bg-red-500/80 text-white px-2 py-1 rounded-full text-sm flex items-center gap-1">
                                <CameraIcon disabled />
                                Camera Off
                            </div>
                        )}
                    </div>
                </div>

                <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-white dark:bg-gray-800 px-6 py-3 rounded-full shadow-lg">
                    <div className="text-xl font-semibold text-purple-600 dark:text-purple-400">
                        {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
                    </div>
                </div>
            </div>
        </Layout>
    );
}

function MicIcon({ muted = false }: { muted?: boolean }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {muted ? (
                <>
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                </>
            ) : (
                <>
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                </>
            )}
        </svg>
    );
}

function CameraIcon({ disabled = false }: { disabled?: boolean }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {disabled ? (
                <>
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M15 7h4a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4" />
                    <path d="M10.66 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3.34" />
                </>
            ) : (
                <>
                    <path d="M23 7l-7 5 7 5V7z" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </>
            )}
        </svg>
    );
} 