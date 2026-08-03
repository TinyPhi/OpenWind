import readline from "readline";
import { spawn } from "child_process";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question(
  "\x1b[31mWARNING: This will permanently delete all local database and storage volumes (Postgres/MinIO/Zitadel/OpenBao). Continue? [y/N]: \x1b[0m",
  (answer) => {
    rl.close();
    const cleanAnswer = answer.trim().toLowerCase();
    if (cleanAnswer === "y" || cleanAnswer === "yes") {
      console.log("\x1b[36mResetting local development environment...\x1b[0m");
      const child = spawn("docker", ["compose", "down", "-v"], {
        stdio: "inherit",
        shell: true,
      });
      child.on("close", (code) => {
        process.exit(code || 0);
      });
    } else {
      console.log("\x1b[32mReset aborted.\x1b[0m");
      process.exit(0);
    }
  },
);
