#!/usr/bin/env python3
"""生成 TJ-VideoPrep 校准片。

用途：验证"源视频 → 分离出的音频 → 打轴软件波形"整条链路有没有引入时间偏移。

设计（为了不用听声音就能判断位置）：
- 音频：**除脉冲外是严格的数字静音**（全零），所以波形是一条平线
- 脉冲：每 5 秒一个，宽度 5 毫秒、幅度 95%，在波形上就是一根满幅竖线
- 画面：每 5 秒闪一帧纯白，与音频脉冲同一时刻；另有一个随时间横向移动的方块

判据：把生成的 mkv 当作普通视频走一遍完整流程（分析 → 分离 → 导入打轴软件），
波形上的竖线应当**精确落在 5 / 10 / 15 / 20 / 25 秒**。
偏了就说明链路有系统性偏移，偏差量可以直接量出来。

用法：
    python make_calib.py [输出目录]

依赖：ffmpeg（PATH 里能找到即可）。音频由本脚本用标准库生成，不需要第三方包。
"""

import math
import os
import shutil
import struct
import subprocess
import sys
import wave

SAMPLE_RATE = 48000
DURATION = 30           # 总时长（秒）
MARKS = [5, 10, 15, 20, 25]   # 脉冲出现的位置（秒）
PULSE_MS = 5            # 脉冲宽度（毫秒）
PULSE_HZ = 1000         # 脉冲频率
AMPLITUDE = 0.95        # 相对满幅
FPS = 25
WIDTH, HEIGHT = 640, 360


def make_silent_wav_with_pulses(path: str) -> None:
    """全零音频，只在 MARK 处插入极短脉冲。"""
    total = SAMPLE_RATE * DURATION
    data = bytearray(total * 4)  # 立体声 16bit = 每帧 4 字节，初始全零
    pulse_len = max(1, int(SAMPLE_RATE * PULSE_MS / 1000))

    for sec in MARKS:
        start = sec * SAMPLE_RATE
        if start + pulse_len > total:
            continue
        for i in range(pulse_len):
            v = int(32767 * AMPLITUDE * math.sin(2 * math.pi * PULSE_HZ * i / SAMPLE_RATE))
            struct.pack_into("<hh", data, (start + i) * 4, v, v)

    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(data))


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    # 常见位置兜底
    for p in [
        r"E:\Scoop\shims\ffmpeg.exe",
        r"C:\ffmpeg\bin\ffmpeg.exe",
    ]:
        if os.path.isfile(p):
            return p
    raise SystemExit("找不到 ffmpeg，请把它放进 PATH 或修改本脚本里的路径")


def build(ffmpeg: str, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, "_calib_audio.wav")
    video_path = os.path.join(out_dir, "_calib_video.mp4")

    print("生成音频（静音 + 脉冲）…")
    make_silent_wav_with_pulses(wav_path)

    # 每 5 秒闪一帧白：25fps 下 5 秒 = 125 帧，用帧号判断精确到帧
    flash = "eq(mod(n\\,125)\\,0)"
    # 一个随时间横向移动的方块，用来看时间在走
    mover = "x='(t/{d})*iw-24':y='ih/2-12':w=24:h=24:color=0x39c5ff@0.85:t=fill".format(d=DURATION)

    print("生成画面（闪帧 + 移动标记）…")
    subprocess.run(
        [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", f"color=c=0x101418:s={WIDTH}x{HEIGHT}:r={FPS}:d={DURATION}",
            "-vf",
            f"drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='{flash}',drawbox={mover}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-g", str(FPS), "-pix_fmt", "yuv420p",
            video_path,
        ],
        check=True,
    )

    for ext in ("mkv", "mp4"):
        out_path = os.path.join(out_dir, f"calib-{DURATION}s.{ext}")
        print(f"合成 {os.path.basename(out_path)} …")
        args = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", video_path,
            "-i", wav_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",
        ]
        if ext == "mkv":
            args += ["-c:a", "flac"]          # 无损，便于验证波形
        else:
            args += ["-c:a", "aac", "-b:a", "192k"]
        args += ["-shortest", out_path]
        subprocess.run(args, check=True)

    os.remove(wav_path)
    os.remove(video_path)

    print("\n完成。脉冲位置（秒）：", ", ".join(str(m) for m in MARKS))
    print(f"输出目录：{out_dir}")


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "calib")
    build(find_ffmpeg(), out_dir)


if __name__ == "__main__":
    main()
