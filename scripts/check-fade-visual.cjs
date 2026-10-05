const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
 const win = new BrowserWindow({show:false,width:980,height:650,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
 try {
 const rate=44100, count=rate*10, wav=Buffer.alloc(44+count*2);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(count*2,40);
 for(let i=0;i<count;i++) wav.writeInt16LE(Math.round(20000*Math.sin(2*Math.PI*440*i/rate)),44+i*2);
 const wavPath=path.join(app.getPath('temp'),'fade-investigation.wav');fs.writeFileSync(wavPath,wav);
 await win.loadFile(path.join(__dirname,'../dist/index.html'));
 await win.webContents.executeJavaScript(`window.loadingStages=[]; new MutationObserver(()=>{
   const text=[...document.querySelectorAll('[role="status"]')].map(node=>node.textContent).join(' ');
   if (/Reading|Decoding|Building waveform/.test(text)) window.loadingStages.push(text);
 }).observe(document.body,{subtree:true,childList:true,characterData:true});`);
 win.webContents.debugger.attach('1.3');
 const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');
 let {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});
 await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[wavPath]});
 await new Promise(r=>setTimeout(r,1200));
 console.log(await win.webContents.executeJavaScript(`(async()=>{
 const canvases=[...document.querySelectorAll('canvas')];
 const wave=canvases.find(c=>c.title.includes('Click to clear'));
 if(!wave)throw Error('Waveform canvas not found');
 const overlay=wave.nextElementSibling;
 const rect=wave.getBoundingClientRect();
 const before=wave.toDataURL();const overlayBefore=overlay.toDataURL();
 const fire=(type,x,y)=>wave.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,button:0,buttons:type==='pointerup'?0:1,clientX:rect.left+x,clientY:rect.top+y}));
 fire('pointermove',rect.width*.0075,10);await new Promise(r=>setTimeout(r,30));
 fire('pointerdown',rect.width*.0075,10);await new Promise(r=>setTimeout(r,30));
 fire('pointermove',rect.width*.25,10);await new Promise(r=>setTimeout(r,50));
 fire('pointerup',rect.width*.25,10);await new Promise(r=>setTimeout(r,50));
 const fadeInChanged=before!==wave.toDataURL();
 const afterIn=wave.toDataURL();
 fire('pointermove',rect.width*.9875,10);await new Promise(r=>setTimeout(r,30));
 fire('pointerdown',rect.width*.9875,10);await new Promise(r=>setTimeout(r,30));
 fire('pointermove',rect.width*.75,10);await new Promise(r=>setTimeout(r,50));
 fire('pointerup',rect.width*.75,10);await new Promise(r=>setTimeout(r,50));
 const fadeOutChanged=afterIn!==wave.toDataURL();
 wave.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-200,clientX:rect.left+rect.width/2,clientY:rect.top+100}));
 await new Promise(r=>setTimeout(r,80));
 const pixels=overlay.getContext('2d').getImageData(0,0,overlay.width,overlay.height).data;
 let blue=0,amber=0;
 for(let i=0;i<pixels.length;i+=4){if(pixels[i]===56&&pixels[i+1]===189&&pixels[i+2]===248)blue++;if(pixels[i]===245&&pixels[i+1]===158&&pixels[i+2]===11)amber++;}
 if(!fadeInChanged||!fadeOutChanged||blue<10||amber<10)throw Error('Fade visual checks failed '+JSON.stringify({fadeInChanged,fadeOutChanged,blue,amber}));
 return JSON.stringify({fadeInChanged,fadeOutChanged,offscreenFadeInPixels:blue,offscreenFadeOutPixels:amber});
 })()`));
 console.log(await win.webContents.executeJavaScript(`JSON.stringify({loadingFeedbackSeen:window.loadingStages.length>0,editingEnabled:!document.querySelector('[inert]')})`));
 await win.reload();await new Promise(r=>setTimeout(r,200));
 const radarDocument=await win.webContents.debugger.sendCommand('DOM.getDocument');
 ({nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:radarDocument.root.nodeId,selector:'input[type=file]'}));
 // Synthetic needle lifts: both are shorter than the default 1 s Auto-Split Gap.
 for(let i=0;i<count;i++) {
   const time=i/rate, quiet=(time>=3&&time<3.3)||(time>=6&&time<6.3);
   wav.writeInt16LE(Math.round((quiet?32:20000)*Math.sin(2*Math.PI*440*i/rate)),44+i*2);
 }
 const radarPath=path.join(app.getPath('temp'),'quiet-radar-check.wav');fs.writeFileSync(radarPath,wav);
 await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[radarPath]});
 await new Promise(r=>setTimeout(r,1000));
 await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Auto-Split').click()`);
 await new Promise(r=>setTimeout(r,100));
 const radarRect=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('canvas[title]').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width}})()`);
 for(const [type,time] of [['mouseMoved',2.99],['mousePressed',2.99],['mouseMoved',3.28],['mouseReleased',3.28]]){
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:radarRect.left+radarRect.width*time/10,y:radarRect.top+70,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,clickCount:1});
 await new Promise(r=>setTimeout(r,60));
 }
 console.log(await win.webContents.executeJavaScript(`(async()=>{
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

 const wave=document.querySelector('canvas[title]'), overlay=wave.nextElementSibling,rect=wave.getBoundingClientRect();
 const fire=(type,time,y=70)=>wave.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:2,button:0,buttons:type==='pointerup'?0:1,clientX:rect.left+rect.width*time/10,clientY:rect.top+y}));

 document.querySelector('[aria-label="Detect noise floor"]').click();await wait(300);
 const threshold=document.querySelector('[aria-label="Noise floor in dB"]').textContent;
 const preview=document.querySelector('[aria-label="Auto-split preview"]').textContent;
 const scale=overlay.width/rect.width; const x=Math.floor(rect.width*6.15/10*scale);
 const brightness=()=>{const data=overlay.getContext('2d').getImageData(x,Math.floor(overlay.height/2),Math.ceil(2*scale),1).data;return Math.max(...Array.from(data).filter((_,index)=>index%4===3));};
 const baseline=brightness();
 fire('pointermove',6.15);await wait(60);fire('pointermove',7);await wait(60);
 const initial=brightness();await wait(500);const fading=brightness();await wait(1900);fire('pointermove',7.1);await wait(60);const gone=brightness();
 if(initial<100||fading>=initial||gone!==baseline)throw Error('Hover radar did not leave a stationary fading trace '+JSON.stringify({initial,fading,gone,baseline,threshold,preview}));
 document.querySelector('[aria-label="Chop"]').click();await wait(60);
 return JSON.stringify({shortQuietHoverRadar:true,threshold,preview,traceAlpha:[initial,fading,gone]});
 })()`));
 const chopRect=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[aria-label="Edit waveform"]').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width}})()`);
 for(const type of ['mouseMoved','mousePressed','mouseReleased']) {
   await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:chopRect.left+chopRect.width*.62,y:chopRect.top+70,button:type==='mouseMoved'?'none':'left',clickCount:1});
   await new Promise(resolve=>setTimeout(resolve,60));
 }
 if(!await win.webContents.executeJavaScript(`!!document.querySelector('[aria-label="Track 2 name"]')`))throw Error('Native single-click Chop failed to place a marker');
 console.log('PASS: native single-click Chop places a marker on the production waveform');
 const beforeFailure=await win.webContents.executeJavaScript(`document.querySelector('canvas[title]').toDataURL()`);
 const invalidPath=path.join(app.getPath('temp'),'fade-invalid-audio.wav');fs.writeFileSync(invalidPath,'invalid audio');
 await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[invalidPath]});
 await new Promise(r=>setTimeout(r,300));
 const failure=await win.webContents.executeJavaScript(`JSON.stringify({errorVisible:document.body.textContent.includes('Could not load audio'),editingEnabled:!document.querySelector('[inert]'),waveform:document.querySelector('canvas[title]').toDataURL()})`);
 const failureResult=JSON.parse(failure);
 if(!failureResult.errorVisible||!failureResult.editingEnabled||failureResult.waveform!==beforeFailure)throw Error('Failed-import recovery check failed');
 console.log('PASS: failed import shows inline error, clears loading and preserves previous waveform');
 } catch(error){console.error(error);process.exitCode=1;} finally {win.destroy();app.quit();}
});
