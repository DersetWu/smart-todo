package com.smarttodo.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String REMINDER_CHANNEL_ID = "smart-todo-reminders-v2";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createReminderChannel();
    }

    private void createReminderChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationChannel channel = new NotificationChannel(
            REMINDER_CHANNEL_ID,
            "醒目待办提醒",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("使用手机默认通知音，并伴随震动");
        channel.setSound(
            Settings.System.DEFAULT_NOTIFICATION_URI,
            new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build()
        );
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 300, 180, 700, 180, 300 });
        channel.enableLights(true);
        channel.setLightColor(0xFF6366F1);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }
}
