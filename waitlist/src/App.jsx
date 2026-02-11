import { useState, useEffect, useRef } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { supabase } from './lib/supabase';

export default function App() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const vantaRef = useRef(null);
  const vantaEffect = useRef(null);

  useEffect(() => {
    if (!vantaEffect.current && window.VANTA) {
      try {
        vantaEffect.current = window.VANTA.GLOBE({
          el: vantaRef.current,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200,
          minWidth: 200,
          scale: 1.0,
          scaleMobile: 1.0,
          color: 0xe0e0e0,
          color2: 0xeeeeee,
          backgroundColor: 0xffffff,
          size: 1.5,
        });
      } catch (err) {
        console.error('Vanta init error:', err);
      }
    } else if (!window.VANTA) {
      console.error('VANTA not loaded. window.VANTA:', window.VANTA, 'window.THREE:', window.THREE);
    }
    return () => {
      if (vantaEffect.current) {
        vantaEffect.current.destroy();
        vantaEffect.current = null;
      }
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus('submitting');
    setErrorMsg('');

    try {
      const { error } = await supabase.from('waitlist_signups').insert({
        email: email.trim().toLowerCase(),
        source: 'landing_page',
        referrer: document.referrer || null,
      });

      if (error) {
        if (error.code === '23505') {
          setStatus('duplicate');
        } else {
          setStatus('error');
          setErrorMsg(error.message || 'Something went wrong.');
        }
      } else {
        setStatus('success');
      }
    } catch {
      setStatus('error');
      setErrorMsg('Network error. Please try again.');
    }
  };

  const submitted = status === 'success' || status === 'duplicate';

  return (
    <div ref={vantaRef} className="relative min-h-screen text-[#111] flex flex-col">
      {/* Nav */}
      <nav className="relative z-10 px-6 lg:px-16 py-5 flex items-center justify-between">
        <span className="text-xl font-bold tracking-tight text-[#111]">
          qualydm
        </span>
        <span className="text-xs tracking-widest uppercase text-[#999] font-medium">
          Early Access
        </span>
      </nav>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex flex-col justify-center px-6 lg:px-16 pb-24">
        <div className="max-w-xl w-full">
          {/* Headline */}
          <h1 className="animate-fade-up-delay-1 text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1] mb-6">
            <span className="shimmer-text text-transparent">
              Stop cold emailing.
            </span>
            <br />
            Start conversations.
          </h1>

          <p className="animate-fade-up-delay-1 text-lg sm:text-xl text-[#666] max-w-lg mb-8 leading-relaxed">
            QualyDM finds people already talking about problems you solve
            and sends them a DM that actually feels human.
          </p>

          <p className="animate-fade-up-delay-2 text-sm text-[#555] mb-12">
            40% reply rate &middot; 20% booked calls &middot; 10k+ DMs/month
          </p>

          {/* Form */}
          <div className="animate-fade-up-delay-3">
            {submitted ? (
              <div className="inline-flex items-center gap-3 bg-[#111] text-white rounded-full px-6 py-3.5">
                <Check size={18} strokeWidth={2.5} />
                <span className="text-sm font-medium">
                  {status === 'duplicate'
                    ? "You're already on the list. We'll be in touch."
                    : "You're in. We'll reach out soon."}
                </span>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                className="flex flex-col sm:flex-row gap-2.5 max-w-md"
              >
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@company.com"
                  className="flex-1 px-4 py-3 bg-white/80 backdrop-blur-sm border border-[#ddd] rounded-full text-[#111] placeholder-[#aaa] focus:outline-none focus:border-[#111] transition-colors text-sm"
                />
                <button
                  type="submit"
                  disabled={status === 'submitting'}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-[#111] hover:bg-[#222] text-white rounded-full text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {status === 'submitting' ? (
                    <span className="animate-spin h-4 w-4 border-2 border-white/30 border-t-white rounded-full" />
                  ) : (
                    <>
                      Get early access
                      <ArrowRight size={15} />
                    </>
                  )}
                </button>
              </form>
            )}

            {status === 'error' && (
              <p className="mt-3 text-sm text-red-500">{errorMsg}</p>
            )}

            {!submitted && (
              <p className="mt-4 text-sm text-[#666]">
                Join the waitlist. Increase your revenue.
              </p>
            )}
          </div>

          {/* Platforms */}
          <div className="animate-fade-in mt-16 flex flex-col gap-4">
            <p className="text-xs tracking-widest uppercase text-[#888] font-medium">
              Platforms
            </p>
            <div className="flex items-center gap-2 text-sm font-medium text-[#111] mb-3">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Reddit launching March
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[#666]">
              <span>X</span>
              <span>Bluesky</span>
              <span>Threads</span>
              <span>LinkedIn</span>
              <span className="italic">coming soon</span>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 px-6 lg:px-16 py-6 border-t border-[#eee]/50">
        <div className="flex items-center justify-between">
          <span className="text-xs text-[#555]">
            &copy; {new Date().getFullYear()} QualyDM
          </span>
          <span className="text-xs text-[#555]">
            Built for outreach that doesn't feel like outreach.
          </span>
        </div>
      </footer>
    </div>
  );
}
