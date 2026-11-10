"""Makes synthetic test photos of pages on desks, with the true corner positions.
usage: python3 gen.py <seed> <outdir>   (seed 11 = the fixed set, any other seed = a random set of 81)"""
import numpy as np, json, random, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import sys
SEED=int(sys.argv[1]) if len(sys.argv)>1 else 11
OUT=sys.argv[2] if len(sys.argv)>2 else 'scenes'
import os; os.makedirs(OUT,exist_ok=True)
random.seed(SEED); np.random.seed(SEED)
W,H=720,960
def page_invoice():
    im=Image.new('RGB',(850,1100),(255,255,255)); d=ImageDraw.Draw(im)
    d.rectangle([80,70,330,110],fill=(42,77,143)); d.rectangle([80,320,770,360],fill=(42,77,143))
    for i,yy in enumerate(range(380,560,45)): d.rectangle([90,yy,90+220+i*30,yy+10],fill=(40,40,40)); d.rectangle([690,yy,760,yy+10],fill=(40,40,40)); d.line([80,yy+28,770,yy+28],fill=(200,200,200),width=1)
    for yy in range(640,700,26): d.rectangle([80,yy,700,yy+9],fill=(50,50,50))
    d.ellipse([90,780,310,890],outline=(192,57,43),width=5)
    return im
doc=page_invoice()

def page_text(color=(255,255,255)):
    im=Image.new('RGB',(850,1100),color); d=ImageDraw.Draw(im)
    y=80
    while y<1020:
        x=70
        while x<760:
            wd=random.randint(20,90)
            if x+wd>780: break
            d.rectangle([x,y,x+wd,y+9],fill=(40,40,45)); x+=wd+12
        y+=26 if random.random()>0.12 else 60
    return im
def page_header():   # dark band reaching the page edges, photo block
    im=page_text(); d=ImageDraw.Draw(im)
    d.rectangle([0,0,850,170],fill=(25,40,90)); d.rectangle([0,1040,850,1100],fill=(30,30,30))
    d.rectangle([60,250,400,520],fill=(90,120,60))
    return im
def page_photo():    # mostly dark picture page with white margins on only some sides
    im=Image.new('RGB',(850,1100),(250,250,250)); d=ImageDraw.Draw(im)
    for i in range(40):
        x=random.randint(0,850);y=random.randint(0,700);r=random.randint(40,200)
        d.ellipse([x-r,y-r,x+r,y+r],fill=tuple(random.randint(20,200) for _ in range(3)))
    d.rectangle([0,760,850,1100],fill=(250,250,250))
    for yy in range(800,1040,30): d.rectangle([60,yy,780,yy+9],fill=(50,50,50))
    return im
def page_blank(color=(252,252,250)):
    im=Image.new('RGB',(850,1100),color); d=ImageDraw.Draw(im)
    d.rectangle([80,90,400,110],fill=(60,60,60)); return im
def page_table():
    im=Image.new('RGB',(850,1100),(255,255,255)); d=ImageDraw.Draw(im)
    for r in range(12):
        y=100+r*75; d.line([60,y,790,y],fill=(0,0,0),width=3)
    for c in range(5):
        x=60+c*182.5; d.line([x,100,x,925],fill=(0,0,0),width=3)
    return im
def page_receipt():
    im=Image.new('RGB',(420,1100),(248,248,244)); d=ImageDraw.Draw(im)
    for yy in range(60,1040,28): d.rectangle([30,yy,random.randint(150,390),yy+8],fill=(60,60,60))
    return im
PAGES={'doc':lambda:doc.copy(),'text':page_text,'header':page_header,'photo':page_photo,'blank':page_blank,'table':page_table,
       'receipt':page_receipt,'yellow':lambda:page_text((245,225,120)),'cream':lambda:page_text((236,226,205))}

yy,xx=np.mgrid[0:H,0:W]
def bg_wood():
    g=np.sin(xx/7.0+np.sin(yy/60.0)*3)*0.5+0.5
    return np.dstack([110+g*40,75+g*28,48+g*18])
def bg_dark(): return np.dstack([40+0*xx,42+0*xx,48+0*xx]).astype(float)+np.random.normal(0,4,(H,W,3))
def bg_lightgrey(): return np.dstack([188+0*xx,188+0*xx,184+0*xx]).astype(float)+np.random.normal(0,3,(H,W,3))
def bg_white(): return np.dstack([226+0*xx,226+0*xx,222+0*xx]).astype(float)+np.random.normal(0,2,(H,W,3))
def bg_checker():
    c=(((xx//60)+(yy//60))%2)*70+90
    return np.dstack([c,c*0.9,c*0.8]).astype(float)
def bg_stripes():
    c=((xx+yy)//25%2)*60+70
    return np.dstack([c*0.7,c*0.8,c]).astype(float)
def bg_carpet(): 
    n=np.random.normal(0,28,(H,W)); return np.dstack([120+n,105+n,95+n])
def bg_clutter():
    im=Image.fromarray(bg_lightgrey().clip(0,255).astype(np.uint8)); d=ImageDraw.Draw(im)
    d.rectangle([0,0,W,150],fill=(35,35,40))                      # laptop/keyboard edge
    for i in range(14):
        for j in range(3): d.rectangle([20+i*50,20+j*40,58+i*50,50+j*40],fill=(70,70,78))
    d.ellipse([560,700,760,900],fill=(250,250,250)); d.ellipse([590,730,730,870],fill=(90,50,20))   # mug
    d.rectangle([0,820,160,960],fill=(240,240,235))                # another white paper corner
    d.line([0,600,W,640],fill=(120,120,120),width=4)                # desk seam
    return np.array(im).astype(float)
def bg_tiles():
    c=np.where((xx%180<4)|(yy%180<4),120,205)
    return np.dstack([c,c,c*0.97]).astype(float)
BGS={'wood':bg_wood,'dark':bg_dark,'lightgrey':bg_lightgrey,'white':bg_white,'checker':bg_checker,'stripes':bg_stripes,'carpet':bg_carpet,'clutter':bg_clutter,'tiles':bg_tiles}

def coeffs(src,dst):
    A=[];B=[]
    for (x,y),(u,v) in zip(dst,src):
        A.append([x,y,1,0,0,0,-u*x,-u*y]);B.append(u)
        A.append([0,0,0,x,y,1,-v*x,-v*y]);B.append(v)
    return np.linalg.solve(np.array(A,float),np.array(B,float))

def make(name,pg,bg,scale=0.72,rot=0,persp=0.0,shadow=False,light=True,blur=0,off=(0,0),hand=False):
    p=PAGES[pg](); pw,ph=p.size
    s=scale*min(W/pw,H/ph)
    hw,hh=pw*s/2,ph*s/2
    cs=[(-hw,-hh),(hw,-hh),(hw,hh),(-hw,hh)]
    a=math.radians(rot); quad=[]
    for i,(x,y) in enumerate(cs):
        k=1-persp if i<2 else 1+persp*0.3     # top narrower
        x*=k
        quad.append((W/2+off[0]+x*math.cos(a)-y*math.sin(a), H/2+off[1]+x*math.sin(a)+y*math.cos(a)))
    base=Image.fromarray(BGS[bg]().clip(0,255).astype(np.uint8))
    c=coeffs([(0,0),(pw,0),(pw,ph),(0,ph)],quad)
    warped=p.transform((W,H),Image.PERSPECTIVE,c,Image.BICUBIC)
    mask=Image.new('L',(W*2,H*2),0); ImageDraw.Draw(mask).polygon([(x*2,y*2) for x,y in quad],fill=255); mask=mask.resize((W,H),Image.LANCZOS)
    sh=Image.new('L',(W,H),0); ImageDraw.Draw(sh).polygon([(x+7,y+9) for x,y in quad],fill=110); sh=sh.filter(ImageFilter.GaussianBlur(7))
    base.paste((20,15,10),(0,0),sh); base.paste(warped,(0,0),mask)
    arr=np.array(base).astype(float)
    if light:
        l=0.72+0.4*(1-np.hypot((xx-W*0.8)/W,(yy-H*0.2)/H)); arr*=l[...,None]
    if shadow:   # soft dark band across the page (arm/phone shadow)
        band=1-0.38*np.exp(-((xx*0.6+yy-H*0.75)/90.0)**2); arr*=band[...,None]
    if hand:     # finger holding the page at the bottom edge
        im=Image.fromarray(arr.clip(0,255).astype(np.uint8)); d=ImageDraw.Draw(im)
        bx=(quad[2][0]+quad[3][0])/2; by=(quad[2][1]+quad[3][1])/2
        d.ellipse([bx-35,by-70,bx+35,by+120],fill=(205,160,130)); arr=np.array(im).astype(float)
    arr+=np.random.normal(0,2.5,arr.shape)
    im=Image.fromarray(arr.clip(0,255).astype(np.uint8))
    if blur: im=im.filter(ImageFilter.GaussianBlur(blur))
    im.save(f'{OUT}/{name}.png'); open(f'{OUT}/{name}.rgb','wb').write(np.array(im).tobytes())
    return {'name':name,'w':W,'h':H,'quad':[[x/W,y/H] for x,y in quad]}

S=[]
if SEED==11:
    i=0
    for bg in BGS:
        for pg in ['doc','header','text','blank','photo','table']:
            if (i%3)!=0 and bg not in('white','lightgrey','clutter'): i+=1; continue
            S.append(make(f'{bg}-{pg}',pg,bg,scale=random.uniform(0.6,0.86),rot=random.uniform(-14,14),persp=random.uniform(0,0.14),
                          shadow=(i%4==1),blur=(1.2 if i%5==2 else 0),off=(random.uniform(-30,30),random.uniform(-40,40)))); i+=1
    S.append(make('wood-receipt','receipt','wood',scale=0.8,rot=6))
    S.append(make('lightgrey-receipt','receipt','lightgrey',scale=0.8,rot=-9,persp=0.05))
    S.append(make('dark-yellow','yellow','dark',rot=10,persp=0.1))
    S.append(make('wood-cream','cream','wood',rot=-7,persp=0.08))
    S.append(make('white-cream','cream','white',rot=4))
    S.append(make('wood-hand','doc','wood',rot=3,hand=True))
    S.append(make('lightgrey-hand','text','lightgrey',rot=-5,hand=True,shadow=True))
    S.append(make('wood-big','doc','wood',scale=0.97,rot=1.5))            # page fills the frame
    S.append(make('lightgrey-big','header','lightgrey',scale=0.96,rot=-1))
    S.append(make('wood-offframe','doc','wood',scale=0.9,rot=4,off=(70,0)))   # right side leaves the frame
    S.append(make('dark-rot30','text','dark',scale=0.6,rot=28))
    S.append(make('clutter-small','doc','clutter',scale=0.5,rot=-12,off=(-40,60)))
else:
    i=0
    for bg in BGS:
        for pg in PAGES:
            S.append(make(f'{bg}-{pg}',pg,bg,scale=random.uniform(0.5,0.95),rot=random.uniform(-20,20),persp=random.uniform(0,0.18),
                          shadow=random.random()<0.3,blur=random.choice([0,0,0.8,1.5]),light=random.random()<0.8,hand=random.random()<0.15,
                          off=(random.uniform(-50,50),random.uniform(-60,60)))); i+=1
json.dump(S,open(OUT+'/index.json','w'))
print(len(S))
