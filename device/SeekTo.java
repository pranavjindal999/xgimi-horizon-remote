package com.xgimi.seek;

import android.content.ComponentName;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.PlaybackState;
import android.os.IBinder;
import android.os.Looper;
import java.io.FileOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.List;

/**
 * Seek the active media session through ISessionManager, the same API the
 * system media controls use. Shell on this device holds MEDIA_CONTENT_CONTROL.
 */
public class SeekTo {
  public static void main(String[] args) {
    try {
      run(args);
    } catch (Throwable error) {
      error.printStackTrace(System.out);
      System.out.println("FAIL " + error);
      System.exit(1);
    }
  }

  private static void run(String[] args) throws Exception {
    if (args.length < 1) {
      System.out.println("USAGE status|<positionMs>");
      System.exit(1);
    }
    Looper.prepareMainLooper();
    Class<?> activityThread = Class.forName("android.app.ActivityThread");
    Object thread = activityThread.getMethod("systemMain").invoke(null);
    Object context = activityThread.getMethod("getSystemContext").invoke(thread);

    Class<?> serviceManager = Class.forName("android.os.ServiceManager");
    IBinder binder =
        (IBinder) serviceManager.getMethod("getService", String.class).invoke(null, "media_session");
    if (binder == null) {
      System.out.println("NO_SERVICE");
      System.exit(2);
    }
    Class<?> stub = Class.forName("android.media.session.ISessionManager$Stub");
    Object manager = stub.getMethod("asInterface", IBinder.class).invoke(null, binder);
    Method getSessions = manager.getClass().getMethod("getSessions", ComponentName.class, int.class);
    @SuppressWarnings("unchecked")
    List<Object> tokens = (List<Object>) getSessions.invoke(manager, new Object[] {null, 0});
    if (tokens == null || tokens.isEmpty()) {
      System.out.println("NO_SESSION");
      System.exit(3);
    }

    MediaController chosen = null;
    int chosenRank = -1;
    Class<?> controllerClass = Class.forName("android.media.session.MediaController");
    Constructor<?> controllerCtor = null;
    for (Constructor<?> ctor : controllerClass.getConstructors()) {
      Class<?>[] params = ctor.getParameterTypes();
      if (params.length == 2 && params[1].isInstance(tokens.get(0))) controllerCtor = ctor;
    }
    if (controllerCtor == null) {
      System.out.println("NO_CONTROLLER_CTOR");
      System.exit(5);
    }
    for (Object token : tokens) {
      MediaController controller = (MediaController) controllerCtor.newInstance(context, token);
      PlaybackState state = controller.getPlaybackState();
      String pkg = controller.getPackageName();
      long actions = state == null ? 0 : state.getActions();
      int stateCode = state == null ? -1 : state.getState();
      System.out.println(
          "SESSION pkg=" + pkg + " state=" + stateCode + " actions=" + actions);
      boolean canSeek = state != null && (actions & PlaybackState.ACTION_SEEK_TO) != 0;
      if (!canSeek) continue;
      int rank = 0;
      if (stateCode == PlaybackState.STATE_PLAYING) rank += 4;
      else if (stateCode == PlaybackState.STATE_PAUSED) rank += 2;
      if (pkg != null && pkg.contains("youtube")) rank += 1;
      if (rank > chosenRank) {
        chosen = controller;
        chosenRank = rank;
      }
    }
    if (chosen == null) {
      System.out.println("NO_SEEK");
      System.exit(4);
    }

    MediaMetadata metadata = chosen.getMetadata();
    long duration = metadata == null ? -1 : metadata.getLong(MediaMetadata.METADATA_KEY_DURATION);
    CharSequence title =
        metadata == null ? "" : metadata.getText(MediaMetadata.METADATA_KEY_TITLE);
    System.out.println(
        "TARGET pkg=" + chosen.getPackageName() + " duration=" + duration + " title=" + title);

    if ("status".equals(args[0])) {
      if (metadata != null) {
        for (String key : metadata.keySet()) {
          CharSequence text = metadata.getText(key);
          String value = text == null ? "" : text.toString().replace('\n', ' ');
          if (value.length() > 300) value = value.substring(0, 300);
          System.out.println("META " + key + "=" + value);
        }
        Bitmap art = metadata.getBitmap(MediaMetadata.METADATA_KEY_ART);
        if (art != null) {
          FileOutputStream out = new FileOutputStream("/data/local/tmp/now-playing.jpg");
          art.compress(Bitmap.CompressFormat.JPEG, 85, out);
          out.close();
          System.out.println("ART_FILE w=" + art.getWidth() + " h=" + art.getHeight());
        }
      }
      System.out.println("OK");
      System.exit(0);
    }

    long positionMs = Long.parseLong(args[0]);
    if (duration > 0) positionMs = Math.max(0, Math.min(Math.max(0, duration - 500), positionMs));
    chosen.getTransportControls().seekTo(positionMs);
    System.out.println("SEEK ms=" + positionMs);
    System.out.println("OK");
    System.exit(0);
  }
}
