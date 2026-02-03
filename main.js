window.onload = main;

function main() {
    const filePicker = document.querySelector("#filePicker");
    const button_encode = document.querySelector("#button_encode");

    if (!filePicker || !button_encode || !log) {
        console.log("UI elements not found.");
        return;
    }

    if (!window.hasOwnProperty("AudioEncoder")) {
        log.innerText = "AudioEncoder not supported by your browser :(";
        return;
    }

    button_encode.onclick = async () => {
        const file = filePicker.files[0];
        if (!file) {
            console.log("Please pick a file first");
            return;
        }

        console.log("Decoding audio...");
        const ctx = new AudioContext();
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        console.log("Encoding to AAC...");
        
        // 1. Prepare the Encoder
        const sampleRate = audioBuffer.sampleRate;
        const numberOfChannels = audioBuffer.numberOfChannels;
        
        const chunks = []; // Will store the final ADTS-wrapped AAC frames

        const encoder = new AudioEncoder({
            output: (encodedChunk, config) => {
                if (encodedChunk.byteLength === 0) return;

                // 2. Create ADTS Header
                const adtsHeader = getADTSHeader(
                    encodedChunk.byteLength, 
                    sampleRate, 
                    numberOfChannels
                );
                
                // 3. Create a buffer with Header + Raw AAC Data
                const packet = new Uint8Array(adtsHeader.length + encodedChunk.byteLength);
                packet.set(adtsHeader);
                
                const rawData = new Uint8Array(encodedChunk.byteLength);
                encodedChunk.copyTo(rawData);
                packet.set(rawData, adtsHeader.length);

                chunks.push(packet);
            },
            error: (e) => {
                console.error("Encoding error:", e);
            },
        });

        let config = {
            codec: 'mp4a.40.2', // AAC LC
            sampleRate: sampleRate,
            numberOfChannels: numberOfChannels,
            bitrate: 192_000,
        };


        let result = await encoder.isConfigSupported(config);

        if (!result.supported) {
            console.log(result);
            log.innerText = "This browser can't encode to AAC";
            return;
        }

        encoder.configure(config);

        encoder.addEventListener("dequeue", (event) => {
            console.log(event);
        });

        // 4. Feed AudioData to encoder in chunks
        const chunkDuration = 1.0; // Process 1 second at a time
        const totalFrames = audioBuffer.length;
        const framesPerChunk = Math.floor(sampleRate * chunkDuration);

        for (let frameOffset = 0; frameOffset < totalFrames; frameOffset += framesPerChunk) {
            const currentFrames = Math.min(framesPerChunk, totalFrames - frameOffset);
        
            let percent = ((frameOffset/totalFrames)*100.0).toFixed(2);
            console.log(`${percent}%`);
            log.innerText = percent;

            // create a planar buffer for this slice
            // f32-planar expects: [Channel 0 Data ...][Channel 1 Data ...]
            const planarData = new Float32Array(currentFrames * numberOfChannels);
            
            for (let ch = 0; ch < numberOfChannels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                // Copy the specific slice of this channel
                const slice = channelData.subarray(frameOffset, frameOffset + currentFrames);
                planarData.set(slice, ch * currentFrames);
            }

            const audioData = new AudioData({
                format: "f32-planar",
                sampleRate: sampleRate,
                numberOfChannels: numberOfChannels,
                numberOfFrames: currentFrames,
                timestamp: (frameOffset / sampleRate) * 1_000_000, // microseconds
                data: planarData
            });

            encoder.encode(audioData);
            audioData.close(); // Important to release memory
        }



        await encoder.flush();
        console.log("Encoding finished.");

        // 5. Download the file
        const blob = new Blob(chunks, { type: 'audio/aac' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name.replace(/\.[^/.]+$/, "") + ".aac";
        a.click();
    };
}

/**
 * Generates an ADTS header for a specific AAC payload length.
 * Standard AAC frame size is 1024 samples.
 */
function getADTSHeader(payloadLength, sampleRate, channelCount) {
    const profile = 2; // AAC LC (Low Complexity) -> 1 (since 0 is Main), but ADTS adds 1? actually indices: 0: Main, 1: LC, 2: SSR
                       // MPEG-4 Audio Object Type: 2 (AAC LC). 
                       // In ADTS header, profile = MPEG-4 Audio Object Type - 1 = 1.
    
    const freqIdx = getSampleRateIndex(sampleRate);
    const chanCfg = channelCount;
    const frameLength = payloadLength + 7; // 7 bytes for header

    const header = new Uint8Array(7);

    // Byte 0: Sync Word (0xFF)
    header[0] = 0xFF;

    // Byte 1: Sync Word (low 4 bits) + MPEG Version (0 for MPEG-4) + Layer (00) + No CRC (1)
    // 1111 0 00 1 = 0xF1
    header[1] = 0xF1;

    // Byte 2: Profile (2 bits) + SampleRate (4 bits) + Private (1 bit) + ChannelConfig (high 1 bit)
    // Profile: 1 (AAC LC)
    header[2] = ((profile - 1) << 6) | (freqIdx << 2) | (chanCfg >> 2);

    // Byte 3: ChannelConfig (low 2 bits) + Orig (0) + Home (0) + CopyID (0) + CopyStart (0) + FrameLength (high 2 bits)
    header[3] = ((chanCfg & 3) << 6) | (frameLength >> 11);

    // Byte 4: FrameLength (middle 8 bits)
    header[4] = (frameLength >> 3) & 0xFF;

    // Byte 5: FrameLength (low 3 bits) + BufferFullness (high 5 bits)
    // Buffer fullness 0x7FF for VBR
    header[5] = ((frameLength & 7) << 5) | 0x1F;

    // Byte 6: BufferFullness (low 6 bits) + Number of blocks (0)
    header[6] = 0xFC;

    return header;
}

function getSampleRateIndex(sampleRate) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const index = rates.indexOf(sampleRate);
    return index === -1 ? 4 : index; // Default to 44100 (index 4) if unknown
}