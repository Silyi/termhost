import { useEffect, useRef } from "react";
import QRCode from "qrcode";

interface Props {
  ips: string[];
  port: number;
}

export default function QRLogin({ ips, port }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || ips.length === 0) return;
    const url = `http://${ips[0]}:${port}/`;
    QRCode.toCanvas(canvas, url, { width: 180, margin: 2 }, (err) => {
      if (err) console.error("QR generation failed", err);
    });
  }, [ips, port]);

  if (ips.length === 0) return null;

  return (
    <div style={{ textAlign: "center", padding: "8px 0" }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>用手机扫码连接</div>
      <canvas ref={canvasRef} style={{ borderRadius: 6 }} />
    </div>
  );
}
