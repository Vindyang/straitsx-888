#!/usr/bin/env bash
#
# A11 — create the KMS signing key and prove custody of it.
#
# Creates an AWS KMS asymmetric secp256k1 (ECC_SECG_P256K1 / SIGN_VERIFY) key,
# attaches a least-privilege key policy so ONLY signer-service's execution role
# may call Sign, derives the Ethereum address from the key's public half, and
# writes KMS_KEY_ID + EXPECTED_SIGNER_ADDRESS into .env.
#
# Why a wizard and not a script the agent runs: creating the key needs AWS
# credentials with kms:CreateKey, and choosing the account and the signer's IAM
# role is a judgement only the operator can make. The private half of the key
# never leaves KMS — that is the whole point, and it is why this cannot be
# automated away with a private key in an env file.
#
#   bash scripts/setup-kms.sh
#
# Re-runnable: it offers to reuse a key already recorded in .env rather than
# creating a second billable key.
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" — clear the screen, then announce a stage and show progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY — current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" — read a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" — like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE — upsert KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE — set a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

# set_var NAME VALUE — set a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

# finish — clear, then a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=6

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

banner "A11 — KMS signing key + custody proof"

# ── 1 ─────────────────────────────────────────────────────────────────────
stage "Preflight — AWS CLI and identity"
say "This wizard creates a REAL, billable AWS KMS key (about USD 1/month)."
note "Its private half never leaves KMS. That is what makes 'the agent never"
note "holds the key' true rather than merely claimed."
printf '\n'

if ! command -v aws >/dev/null 2>&1; then
  warn "the aws CLI is not installed on this machine."
  open_url "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  say "Install it, run 'aws configure', then re-run this wizard."
  exit 1
fi
note "aws CLI: $(aws --version 2>&1)"

ask AWS_REGION "AWS region for the key (e.g. ap-southeast-1):"
if [[ -z "$AWS_REGION" ]]; then
  warn "a region is required — the key is regional and the signer must read it from the same one."
  exit 1
fi

if ! AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
  warn "aws sts get-caller-identity failed — you are not authenticated."
  say "Run 'aws configure' (or set AWS_PROFILE) and re-run this wizard."
  exit 1
fi
note "authenticated to AWS account $AWS_ACCOUNT_ID in $AWS_REGION"
pause "Correct account? Press Enter to continue, Ctrl-C to stop."

# ── 2 ─────────────────────────────────────────────────────────────────────
stage "The signer's IAM role — least privilege"
say "The key policy will allow Sign to ONE role only: the role signer-service runs as."
note "execution_plan.md §11: policy-service and signer-service run under DIFFERENT"
note "roles, so a compromised policy-service still cannot call Sign directly."
printf '\n'
step "If that role does not exist yet, create it in the IAM console first."
open_url "https://console.aws.amazon.com/iam/home#/roles"
ask SIGNER_ROLE_ARN "Paste the signer-service role ARN (arn:aws:iam::...:role/...):"

if [[ ! "$SIGNER_ROLE_ARN" =~ ^arn:aws:iam::[0-9]+:role/ ]]; then
  warn "that does not look like an IAM role ARN."
  say "Expected: arn:aws:iam::${AWS_ACCOUNT_ID}:role/<role-name>"
  exit 1
fi

# ── 3 ─────────────────────────────────────────────────────────────────────
stage "Create the KMS key"

KMS_KEY_ID="$(_existing KMS_KEY_ID || true)"
if [[ -n "$KMS_KEY_ID" ]]; then
  say "$ENV_FILE already records a key:"
  note "  KMS_KEY_ID=$KMS_KEY_ID"
  if confirm "Reuse it? (No creates a SECOND billable key with a NEW address)"; then
    note "reusing the existing key"
  else
    KMS_KEY_ID=""
  fi
fi

if [[ -z "$KMS_KEY_ID" ]]; then
  say "About to create: ECC_SECG_P256K1, SIGN_VERIFY, in $AWS_REGION."
  warn "A KMS key cannot be deleted immediately — deletion has a 7-30 day waiting period."
  if ! confirm "Create the key now?"; then
    say "Nothing created. Re-run when ready."
    exit 0
  fi

  POLICY_FILE="$(mktemp)"
  trap 'rm -f "$POLICY_FILE"' EXIT
  cat > "$POLICY_FILE" <<POLICY
{
  "Version": "2012-10-17",
  "Id": "straitsx-888-signer-key-policy",
  "Statement": [
    {
      "Sid": "EnableAccountAdministration",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${AWS_ACCOUNT_ID}:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowSignerServiceToSignOnly",
      "Effect": "Allow",
      "Principal": { "AWS": "${SIGNER_ROLE_ARN}" },
      "Action": [ "kms:Sign", "kms:GetPublicKey", "kms:DescribeKey" ],
      "Resource": "*"
    }
  ]
}
POLICY

  if ! KMS_KEY_ID=$(aws kms create-key \
        --region "$AWS_REGION" \
        --key-spec ECC_SECG_P256K1 \
        --key-usage SIGN_VERIFY \
        --description "straitsx-888 signer-service EIP-3009 signing key (A11)" \
        --policy "file://$POLICY_FILE" \
        --query KeyMetadata.KeyId --output text 2>&1); then
    warn "create-key failed:"
    note "$KMS_KEY_ID"
    say "The usual cause is missing kms:CreateKey, or a role ARN that does not exist yet."
    exit 1
  fi
  printf '  %s+ created%s KMS key %s\n' "$GREEN" "$RESET" "$KMS_KEY_ID"

  ALIAS="alias/straitsx-888-signer"
  if aws kms create-alias --region "$AWS_REGION" \
       --alias-name "$ALIAS" --target-key-id "$KMS_KEY_ID" >/dev/null 2>&1; then
    note "alias $ALIAS -> $KMS_KEY_ID"
  else
    note "alias $ALIAS already exists or could not be created (harmless)"
  fi
fi

# ── 4 ─────────────────────────────────────────────────────────────────────
stage "Derive the paying address (the custody proof)"
say "Fetching the PUBLIC half of the key and deriving its Ethereum address."
note "GetPublicKey returns SPKI DER. No private key material is involved, here"
note "or ever — that is what makes this a proof rather than a claim."
printf '\n'

if ! PUBKEY_B64=$(aws kms get-public-key \
      --region "$AWS_REGION" --key-id "$KMS_KEY_ID" \
      --query PublicKey --output text 2>&1); then
  warn "get-public-key failed:"
  note "$PUBKEY_B64"
  exit 1
fi

if ! EXPECTED_SIGNER_ADDRESS=$(printf '%s' "$PUBKEY_B64" | pnpm --silent tsx scripts/derive-kms-address.ts 2>&1); then
  warn "address derivation failed:"
  note "$EXPECTED_SIGNER_ADDRESS"
  exit 1
fi

printf '\n  %s%sderived address: %s%s\n\n' "$BOLD" "$GREEN" "$EXPECTED_SIGNER_ADDRESS" "$RESET"
say "signer-service re-derives this at boot and REFUSES TO START if it disagrees."

# ── 5 ─────────────────────────────────────────────────────────────────────
stage "Write the values into $ENV_FILE"
write_env AWS_REGION "$AWS_REGION"
write_env KMS_KEY_ID "$KMS_KEY_ID"
write_env EXPECTED_SIGNER_ADDRESS "$EXPECTED_SIGNER_ADDRESS"
write_env SIGNER_KEY_SOURCE "kms"
printf '\n'
note "SIGNER_ROLE_ARN is deliberately NOT written: no service reads it, and every"
note "var in .env must appear in .env.example (conventions.md §4)."
pause "Press Enter to continue."

# ── 6 ─────────────────────────────────────────────────────────────────────
stage "Fund the new address — the custody move"
warn "The new address holds NOTHING. No signature it produces can settle yet."
printf '\n'
say "The organisers funded a DIFFERENT wallet (the funding origin):"
note "  0x9f6B4A5DE73CE365238F27236ea04A747E691bF7 — 30 XSGD on both chains"
say "Move that balance to the address above. Fuji (43113) first; mainnet only"
say "after the Fuji leg has actually settled."
printf '\n'
step "Build the unsigned transfer:"
note "  pnpm tsx scripts/move-xsgd.ts --chain 43113 --to $EXPECTED_SIGNER_ADDRESS"
step "Sign and broadcast it IN YOUR OWN WALLET APP."
printf '\n'
warn "Never paste the funding wallet's private key into this repo, this terminal,"
warn "or any agent context. The script builds an UNSIGNED transaction for exactly"
warn "that reason."

finish
