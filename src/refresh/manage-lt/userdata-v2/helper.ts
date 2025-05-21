export function heredocAndchmod({
  filename,
  script
}: {
  filename: string
  script: string
}): string {
  return `cat <<'EOF'> ${filename}
${script}
EOF
chmod +x ${filename}
`
}
