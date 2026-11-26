-- Spec 042, R5 : date de la dernière impression d'un QR.
ALTER TABLE "QrCode" ADD COLUMN "printedAt" TIMESTAMPTZ(3);
