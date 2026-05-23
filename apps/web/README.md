# VIPFlow Web App

Web uygulamasi React + Vite ile calisir bir operasyon paneli olarak baslatildi.

## Calistirma

1. Koku dizinde bagimliliklari kur:

	npm install

2. API'yi ayaga kaldir:

	npm run dev:api

3. Web paneli ayaga kaldir:

	npm run dev:web

4. Tarayicida ac:

	http://localhost:5173

## Desteklenen Ekranlar

- Operasyon canli metrikleri (live dashboard)
- Notification delivery log listesi
- Dead-letter listesi
- CSV ve JSON export tetikleme
- Dead-letter retry ve dry-run tetikleme
- Realtime socket event akisi (reservation.created, reservation.status.updated)
- Otomatik reconnect, son baglanti zamani ve toast bildirimleri
- Event filtreleme (tur + reservation) ve subscribe.reservation butonu
- Pause/resume event feed, max event limiti ve log temizleme
- Yalnizca subscribe edilen reservation eventlerini gosterme ve event JSON export
- Socket health test (manuel + periyodik ping), RTT ve failure metrikleri
- Event severity rozetleri (high/medium/low) ve tarih araligiyla filtreli export

## Zorunlu Giris Bilgileri

Panel uzerinden su alanlar girilir:

- API Base URL (varsayilan: http://localhost:3000)
- Tenant ID
- User ID
- Access Token

Bu bilgiler API headerlari olarak gonderilir.
