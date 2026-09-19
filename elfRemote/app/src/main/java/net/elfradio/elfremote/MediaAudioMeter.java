package net.elfradio.elfremote;

/** 只保留音量统计，不保存音频内容；短促声音也计入整个窗口。 */
final class MediaAudioMeter {
    private long since=-1,count,energy;
    private int peak;
    synchronized String add(byte[] bytes,long now){
        if(since<0)since=now;
        for(int i=0;i+1<bytes.length;i+=2){int v=(short)((bytes[i]&255)|(bytes[i+1]<<8));peak=Math.max(peak,Math.abs(v));energy+=(long)v*v;count++;}
        if(now-since<5000)return null;
        String result="rms="+(count==0?0:(int)Math.sqrt((double)energy/count))+" peak="+peak+" samples="+count;
        since=now;count=energy=0;peak=0;return result;
    }
}
