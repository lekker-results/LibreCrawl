"""Token bucket rate limiter for smooth request distribution"""
import time
import threading


class RateLimiter:
    """
    Token bucket rate limiter that ensures smooth, steady request distribution.
    Prevents bursting by spacing out requests evenly over time.
    """

    def __init__(self, requests_per_second=1.0):
        """
        Initialize rate limiter.

        Args:
            requests_per_second: Target request rate (e.g., 1.0 = 1 req/sec, 0.5 = 1 req every 2 sec)
        """
        self.requests_per_second = max(0.01, requests_per_second)  # Minimum rate
        self.min_interval = 1.0 / self.requests_per_second if self.requests_per_second > 0 else 0
        self.last_request_time = 0
        self.lock = threading.Lock()

    def acquire(self):
        """
        Acquire permission to make a request.
        Reserves the next available time slot while holding the lock, then
        sleeps outside the lock so concurrent threads don't serialize on sleep.
        """
        with self.lock:
            now = time.time()
            if self.last_request_time + self.min_interval > now:
                wait_until = self.last_request_time + self.min_interval
            else:
                wait_until = now
            self.last_request_time = wait_until

        sleep_time = wait_until - time.time()
        if sleep_time > 0:
            time.sleep(sleep_time)

    def update_rate(self, requests_per_second):
        """Update the rate limit dynamically"""
        with self.lock:
            self.requests_per_second = max(0.01, requests_per_second)
            self.min_interval = 1.0 / self.requests_per_second if self.requests_per_second > 0 else 0
