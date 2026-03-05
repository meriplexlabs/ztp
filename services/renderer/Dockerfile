FROM python:3.12-slim

# Create non-root user
RUN useradd --system --create-home --shell /bin/bash renderer

WORKDIR /app

# Install dependencies as root, then switch user
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY --chown=renderer:renderer . .

USER renderer

EXPOSE 8001

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]
