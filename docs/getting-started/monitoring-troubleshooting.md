# Monitoring, Logging, and Troubleshooting

!!! warning "Needs improvement"
    Feel free to raise pull requests to improve this page!

## Runner Logs

Looking for specific signals. As per the [architecture](../todo.md), the Github Runners and Instances communicate with each other via various "signals". You can see the state of specific instances via very specific signals.

## Accessing an instance

If something has gone wrong, it might be worth looking at the logs the userdata is producing. Once you have access to the instance - I recommend tailing the user-data logs.

```bash
tail -f /var/logs/user-data.logs
```

## Accessing DynamoDB Database

Add prescription on seeing the dynamodb database. How to look at the underlying data structures.

## Accessing the SQS Queues

Add prescription on how to read the SQS queues.
