import math, numpy as np, wave, os
from scipy.signal import lfilter
RATE=32000
# Run from the repository root; output WAVs to /tmp for conversion.
rng=np.random.default_rng(41025)

def note(semi):return 440*2**((semi-69)/12)
def add(buf,start,duration,pitch,amp=0.2,kind='pluck',pan=0):
    n=int(duration*RATE); a=int(start*RATE)
    if a>=len(buf) or a+n<=0:return
    t=np.arange(n)/RATE; f=note(pitch); phase=2*np.pi*f*t
    if kind=='pluck':
        x=(np.sin(phase)+.35*np.sin(2*phase)+.16*np.sin(3*phase)+.07*np.sin(5*phase))*np.exp(-5.0*t/max(duration,.2))
        env=np.minimum(1,t/.009)*np.minimum(1,(duration-t)/.08)
    elif kind=='bell':
        x=(np.sin(phase)+.33*np.sin(2.01*phase)+.18*np.sin(3.87*phase))*np.exp(-4*t/max(duration,.2));env=np.minimum(1,t/.004)*np.minimum(1,(duration-t)/.12)
    elif kind=='pad':
        x=(np.sin(phase)+.26*np.sin(2*phase)+.10*np.sin(3*phase));env=np.sin(np.pi*t/duration)**.65
    elif kind=='bass':
        x=np.sin(phase)+.22*np.sin(2*phase);env=np.minimum(1,t/.012)*np.exp(-2.5*t/duration)*np.minimum(1,(duration-t)/.08)
    x=x*env*amp
    b=max(a,0);e=min(a+n,len(buf));buf[b:e,0]+=x[b-a:e-a]*math.sqrt((1-pan)/2);buf[b:e,1]+=x[b-a:e-a]*math.sqrt((1+pan)/2)
def drum(buf,start,kind,amp=.1):
    n=int((.19 if kind=='kick' else .095)*RATE);a=int(start*RATE);t=np.arange(n)/RATE
    if kind=='kick': x=np.sin(2*np.pi*(56*t+75*(1-np.exp(-t*42))/42))*np.exp(-28*t)
    elif kind=='hat':x=rng.normal(size=n)*np.exp(-65*t);x=lfilter([1,-.9],[1],x)
    else:x=rng.normal(size=n)*np.exp(-33*t);x=lfilter([1,-.65],[1],x)
    e=min(a+n,len(buf));
    if e>a:buf[a:e]+=amp*x[:e-a,None]*.707

def finish(buf,name):
    # Subtle stereo slap at short delays, plus headroom.
    buf[int(.105*RATE):,0]+=.115*buf[:-int(.105*RATE),1].copy()
    buf[int(.15*RATE):,1]+=.095*buf[:-int(.15*RATE),0].copy()
    peak=np.max(abs(buf));buf*=min(1,.79/peak)
    with wave.open('/tmp/'+name+'.wav','wb') as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(RATE);w.writeframes((buf*32767).astype('<i2').tobytes())
    print(name,len(buf)/RATE,peak)

# Original game-show palette: springy bass, toy-like keys, offbeat claps and a
# rising two-bar turnaround. No borrowed themes or samples.
bpm=120; beat=60/bpm; bars=8; dur=bars*4*beat
b=np.zeros((round(dur*RATE),2),dtype=np.float64)
chords=[[48,52,55,59],[45,48,52,55],[50,53,57,60],[43,47,50,55],
        [48,52,55,59],[45,48,52,55],[50,53,57,60],[43,47,50,55]]
# Varied 3+3+2 rhythm avoids quoting any existing game-show cue.
for bar,ch in enumerate(chords):
 s=bar*4*beat
 for j,n in enumerate(ch[1:]):add(b,s,3.85*beat,n,.024,'pad',[-.5,0,.5][j])
 for step,n in enumerate([ch[0]-12,ch[0]-12,ch[2]-12,ch[0]-12]):
  add(b,s+step*beat,.55*beat,n,.17,'bass',-.08)
 for k,i in enumerate([0,2,1,3,2,1,3,0]):
  if k in (0,3,6): add(b,s+k*.5*beat,.34*beat,ch[i]+12,.15,'bell',(-.3 if k%2 else .3))
  else:add(b,s+k*.5*beat,.31*beat,ch[i]+12,.10,'pluck',(-.35 if k%2 else .35))
 for j in (1,3):drum(b,s+j*beat,'snare',.10)
 for j in (0,2):drum(b,s+j*beat,'kick',.078)
 for j in range(8):drum(b,s+j*.5*beat,'hat',.023 if j%2 else .014)
 if bar in (3,7):
  for j in range(4):add(b,s+(2+j*.5)*beat,.30*beat,ch[[0,1,2,3][j]]+24,.057,'bell',.58)
finish(b,'checards-menu')

# A repeating decision-clock motif, not an actual timer: even beats and a
# 3+3+2 pluck ostinato stay under turn-taking, with a small lift every 4 bars.
bpm=116;beat=60/bpm;bars=16;dur=bars*4*beat
b=np.zeros((round(dur*RATE),2),dtype=np.float64)
chords=[[45,48,52,55],[43,47,50,55],[41,45,48,52],[43,46,50,53],
        [45,48,52,55],[40,43,47,52],[41,45,48,52],[43,47,50,55]]*2
for bar,ch in enumerate(chords):
 s=bar*4*beat
 for j,n in enumerate(ch[1:]):add(b,s,3.9*beat,n,.013,'pad',[-.5,0,.5][j])
 for step in range(4):
  add(b,s+step*beat,.53*beat,ch[0]-12,.09 if step%2 else .13,'bass',-.06)
  add(b,s+step*beat,.13*beat,ch[3]+12,.073 if step==3 else .057,'bell',.25)
 for step,i in enumerate([0,2,1,3,0,1,3,2]):
  if step in (0,3,6):add(b,s+step*.5*beat,.27*beat,ch[i]+12,.072,'pluck',-.36 if step%2 else .36)
  if bar%4==3 and step>=4:add(b,s+step*.5*beat,.19*beat,ch[i]+24,.043,'bell',.5)
 for step in (0,4):drum(b,s+step*.5*beat,'kick',.041)
 for step in (2,6):drum(b,s+step*.5*beat,'snare',.035)
 for step in range(8):drum(b,s+step*.5*beat,'hat',.014)
finish(b,'checards-game')

# Result fanfares: short, distinct, punchy, and non-looping.
for name,ch,up in [('checards-win',[48,52,55,60],True),('checards-lose',[45,48,52,57],False)]:
 b=np.zeros((int(2.5*RATE),2),dtype=np.float64)
 tones=([60,64,67,72,79] if up else [69,65,62,57,52])
 for i,n in enumerate(tones):
  add(b,i*.155,.39 if i<4 else 1.5,n,.20 if up else .14,'bell',-.45+i*.23)
  if i in (0,3):drum(b,i*.155,'kick',.095)
  if i in (1,4):drum(b,i*.155,'snare',.065)
 for j,n in enumerate(ch):add(b,.69,1.62,n,.049,'pad',-.4+j*.25)
 add(b,.72,1.18,ch[0]-12,.18,'bass')
 finish(b,name)
