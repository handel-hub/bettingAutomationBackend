# Keygen Offline Deployment Kit

This kit contains a completely portable, air-gapped deployment for Keygen Community Edition.
It is completely self-contained and requires zero internet connectivity.

## Prerequisites
- Windows 10/11 Pro or Enterprise (x64)
- Hardware Virtualization enabled in BIOS
- Minimum 8 GB RAM recommended

## Installation (Fresh Deploy)
1. Extract this archive to your target machine.
2. Right-click `scripts\bat\install.bat` and **Run as Administrator**.
3. If the script prompts you to reboot (to enable WSL), reboot and run `install.bat` again.
4. The script will guide you through hostname configuration and auto-generate secure passwords.
5. Save the generated `ADMIN PASSWORD` provided at the end of the installation!

## Migration (Scenario: Machine A to Machine B)
1. On Machine A, run `scripts\bat\backup.bat`. This creates a timestamped `backups\` folder.
2. Transfer this Kit AND the `backups\` folder to Machine B.
3. On Machine B, run `scripts\bat\install.bat` to install Docker and load images.
4. On Machine B, run `scripts\bat\restore.bat path\to\backups\YYYY-MM-DD_HHmmss`.
5. Your data, configuration, and internal TLS Root CA are now fully migrated.

## Trusting the Certificate
This kit uses Caddy to automatically generate an internal TLS Root CA.
For your Backend to communicate with Keygen over HTTPS, you must import the Root CA into your Backend's trust store.
The Root CA is exported to: `C:\KeygenEnv\tls\keygen-root-ca.crt`

## Daily Operations
All operational scripts are in `scripts\bat\`:
- `start.bat` - Starts the Keygen stack.
- `stop.bat` - Stops the Keygen stack.
- `health.bat` - Performs a comprehensive health check.
- `status.bat` - Shows Docker container status.
- `diagnostics.bat` - Gathers logs and system info into a ZIP file.
