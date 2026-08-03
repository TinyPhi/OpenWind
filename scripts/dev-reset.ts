import readline from "readline";
import { spawn, execSync } from "child_process";

try {
  execSync("docker --version", { stdio: "ignore" });
} catch {
  console.error(
    "\x1b[31mError: docker CLI not found in PATH. Please ensure Docker is installed and running.\x1b[0m",
  );
  process.exit(1);
}

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
