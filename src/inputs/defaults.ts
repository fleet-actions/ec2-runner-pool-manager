import type { ResourceClassConfigInput } from './types.js'

export const RESOURCE_CLASS_CONFIG_DEFAULT: ResourceClassConfigInput = {
  large: { cpu: 2, mmem: 4096 },
  xlarge: { cpu: 4, mmem: 8192 },
  '2xlarge': { cpu: 8, mmem: 16384 },
  '4xlarge': { cpu: 16, mmem: 32768 },
  '8xlarge': { cpu: 32, mmem: 65536 },
  '12xlarge': { cpu: 48, mmem: 98304 },
  '16xlarge': { cpu: 64, mmem: 131072 }
}

export const DEFAULT_SCRIPT = `
sudo dnf update -y
sudo dnf install docker git libicu -y
sudo systemctl enable docker
sudo systemctl start docker
echo "UserData execution completed successfully at $(date)" >> /var/log/user-data-completion.log
cat /var/log/user-data-completion.log
`

export const REFRESH_DEFAULTS = {
  'github-reg-token-refresh-min': 30,
  'idle-time-sec': 300,
  'max-runtime-min': 30,
  'pre-runner-script': DEFAULT_SCRIPT,
  'resource-class-config': RESOURCE_CLASS_CONFIG_DEFAULT
}

export const UNSPECIFIED_MAX_RUNTIME_MINUTES = -1

export const PROVISION_DEFAULT = {
  'instance-count': 1,
  'usage-class': 'spot',
  'resource-class': 'large',
  'allowed-instance-types': ['c*', 'm*', 'r*'],
  'max-runtime-min': UNSPECIFIED_MAX_RUNTIME_MINUTES
}
