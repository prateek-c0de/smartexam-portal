/*
# Tune AI proctoring sensitivity, sustain windows & cooldowns for real-world webcams

Updates `default_proctoring_config()` so real-world laptop webcam detections from
quantized EfficientDet-Lite0 (`cell phone` >= 0.32) and BlazeFace (`multiple_faces` >= 0.35)
are accepted reliably without requiring unnatural 5+ second holds, while still filtering
sub-0.32 noise and preventing alert spam.
*/

CREATE OR REPLACE FUNCTION public.default_proctoring_config()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '{
    "require_camera": true,
    "require_microphone": true,
    "require_screen": true,
    "capture_evidence": false,
    "face_detection": true,
    "object_detection": true,
    "audio_monitoring": true,
    "weights": {
      "tab_switch": 5, "window_blur": 2, "fullscreen_exit": 3, "face_not_detected": 10,
      "multiple_faces": 15, "camera_obstructed": 8, "phone_detected": 20, "prohibited_object": 10,
      "voice_activity": 5, "audio_anomaly": 2, "copy_paste": 3, "screen_share_ended": 5,
      "page_reload": 1, "camera_interrupted": 0, "mic_interrupted": 0, "network_offline": 0,
      "network_restored": 0, "monitoring_error": 0
    },
    "thresholds": { "moderate": 15, "high": 40 },
    "min_confidence": {
      "multiple_faces": 0.35, "phone_detected": 0.32, "prohibited_object": 0.38,
      "voice_activity": 0.5, "face_not_detected": 0, "camera_obstructed": 0.65
    },
    "cooldown_seconds": {
      "default": 15, "tab_switch": 3, "window_blur": 10, "fullscreen_exit": 5,
      "face_not_detected": 15, "multiple_faces": 12, "phone_detected": 12,
      "prohibited_object": 25, "voice_activity": 30, "audio_anomaly": 45, "copy_paste": 10
    },
    "sustain_seconds": {
      "face_not_detected": 3, "multiple_faces": 1, "phone_detected": 1,
      "prohibited_object": 2, "voice_activity": 4, "camera_obstructed": 2
    }
  }'::jsonb;
$$;
