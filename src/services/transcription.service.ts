import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);

export class TranscriptionService {
  private readonly model: string;

  constructor(model = "base") {
    this.model = model;
  }

  async transcribe(audioBuffer: Buffer, ext = "ogg"): Promise<string> {
    const id = randomUUID();
    const workDir = join(tmpdir(), "im-claude-whisper", id);
    await mkdir(workDir, { recursive: true });

    const inputFile = join(workDir, `audio.${ext}`);

    try {
      await writeFile(inputFile, audioBuffer);

      await execAsync(
        `whisper "${inputFile}" --model ${this.model} --output_format txt --output_dir "${workDir}"`,
        { timeout: 120_000 },
      );

      const outputFile = join(workDir, "audio.txt");
      const text = await readFile(outputFile, "utf-8");
      return text.trim();
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
