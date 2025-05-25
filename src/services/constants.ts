// src/services/constants.ts

export const Timing = {
  // Specific operation timeouts (in seconds)
  HEARTBEAT_POLL_INTERVAL: 5, // heartbeat interval. Wider=better in cpu util; x= in keeping better knowledge of worker health
  HEARTBEAT_HEALTH_TIMEOUT: 15, // Better to be >= x3 Poll timeout. 2x may be too small for DDB eventual consistency

  // Fleet validation - to watch setup + registration of instances
  // FLEET_VALIDATION_TIMEOUT must encompass expected OS bootup + userdata + github runner registration
  // This looks for a specific signal that indicates successful bootup
  FLEET_VALIDATION_TIMEOUT: 180,
  FLEET_VALIDATION_INTERVAL: 10,

  // Instance claim from pool - Claim timeout to watch registration status of an instance
  // WORKER_CLAIM_TIMEOUT must encompass expected gh-registration
  // Smaller timeout=faster selection; =but too small will likely drop valid instances while they are registering
  // ... ./config.sh registration actually takes about ~2-3s. But blockRegistration intervals + latency push acknowledgements to about 5-6 -
  // ... so 10s appears to be safe.
  // ... note: this can be bad if a claim worker timesout on multiple selected instances. The provision-selection takes too long
  WORKER_CLAIM_TIMEOUT: 10,
  WORKER_CLAIM_INTERVAL: 0.5, // shorter=faster selection; =pollution of provision logs

  // Release timeout - To watch successful deregistration & gh runner shutdown.
  // WORKER_RELEASE_TIMEOUT must encompass config dereg and gh runner process shutdown
  // ... on proper deregistration, this can take ~50-60s, on fast shutdown, this is just a few seconds.
  // ... eitherway, interval is not as critical here
  WORKER_RELEASE_TIMEOUT: 120,
  WORKER_RELEASE_INTERVAL: 10,

  // Used specifically in the registration loop
  BLOCK_REGISTRATION_INTERVAL: 0.25,
  BLOCK_INVALIDATION_INTERVAL: 10 // longer, the better (less cpu stress on job runs)
}
