# Mac build host (Paperclip `ssh` environment)

iOS apps can only be built and signed on a Mac. Paperclip runs on the VPS, so the
Mac becomes an **environment**: Paperclip reaches it over SSH through Tailscale
(no router ports open), copies the project worktree to the Mac, runs the agent
there (`claude_local` with Xcode), and copies new commits back. More Macs mean more
environments; each project or agent picks one.

`mac-build-host.sh` checks a Mac and prints the values to enter in Paperclip. By
default it changes nothing. `--setup` creates the workspace folder, puts the tool
PATH in `~/.zshenv` (non-interactive SSH sessions read only that file) and makes a
Paperclip SSH key that is allowed in `~/.ssh/authorized_keys`.

## One-time setup

On the Mac:
1. `bash mac-build-host.sh --setup` and fix what it lists:
   - **Remote Login:** System Settings → General → Sharing → Remote Login, on for your user only.
   - **Tailscale:** install it and log in to the same tailnet as the VPS.
   - **No sleep:** set the Mac to prevent sleep and to wake for network access.
   - **claude CLI:** install it (`npm install -g @anthropic-ai/claude-code`) and run `claude` once in Terminal to log in.
   - **asc:** keep one `asc` profile per App Store Connect team (`asc auth login --name <team>`).
   - **Signing and `asc` over SSH:** the login keychain is locked in an SSH session, so `asc` profiles and keychain signing fail. Run `bash mac-asc-setup.sh` once (it asks for the issuer id): it writes `~/.config/pib/asc.env` (key id, issuer id and the path of the `.p8`, mode 600) and checks that `asc` works from those alone. The `pib-ios-release` skill loads that file and signs with the API key.
2. Copy the private key into a Paperclip company secret: `pbcopy < ~/.ssh/paperclip_env_ed25519`,
   then Company settings → Secrets → New. After that, delete the file from the Mac.

On the VPS (once): install Tailscale and join the same tailnet
(`curl -fsSL https://tailscale.com/install.sh | sh && tailscale up`, which gives you a login link).

In Paperclip:
1. Instance settings → Experimental → **Enable Environments**.
2. Company settings → Environments → New → **SSH**, with the values the script printed:
   host (the Tailscale name), port 22, username, remote workspace path, private key (the secret),
   known hosts (the line the script printed). Then **Probe**.
3. For each iOS project: Project → Settings → Execution environment → the Mac. Or give a
   `claude_local` agent the Mac as its default environment.
4. Project env (Project → Settings → Env, bound to company secrets) for signing with the API key:
   `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_PATH` (the `.p8` path on the Mac, e.g.
   `/Users/<you>/private_keys/AuthKey_<id>.p8`).
5. Attach the `pib-ios-release` skill (CRM plugin) to the agent that builds.

## Notes
- Only `claude_local`, `codex_local`, `paperclip_runner`, `cursor`, `gemini_local`,
  `grok_local`, `kimi_local`, `opencode_local` and `pi_local` agents can run in an SSH
  environment. Hermes and HTTP agents cannot.
- There is no automatic failover between Macs. If a Mac is off, point the project at another one.
- Over SSH the login keychain is locked. Sign with the App Store Connect API key
  (`xcodebuild -allowProvisioningUpdates -authenticationKey…`) so no keychain is needed.
  If a team needs local certificates, use a separate signing keychain that the agent unlocks
  with a secret (`PIB_SIGNING_KEYCHAIN`, `PIB_SIGNING_KEYCHAIN_PASSWORD`).
- App Review submissions always wait for a person.
