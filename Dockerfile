FROM python:3.12-slim

WORKDIR /app

COPY requirements-signaling.txt .
RUN pip install --no-cache-dir -r requirements-signaling.txt

COPY signaling_server.py .

EXPOSE 8787

CMD ["python3", "signaling_server.py"]
