package net.elfradio.elfremote;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import java.io.ByteArrayOutputStream;

/** 仅生成即时显示小图，归档仍使用相机原始JPEG。 */
final class MediaPhotoPreview {
    static byte[] create(byte[] original) {
        if (original.length <= 66000) return original;
        Bitmap image = null;
        try {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(original, 0, original.length, options);
            if (options.outWidth <= 0 || options.outHeight <= 0) return null;
            options.inJustDecodeBounds = false;
            options.inSampleSize = 1;
            while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 1280)
                options.inSampleSize *= 2;
            image = BitmapFactory.decodeByteArray(original, 0, original.length, options);
            if (image == null) return null;
            for (int edge : new int[]{640, 480, 320, 160}) {
                int longest = Math.max(image.getWidth(), image.getHeight());
                if (longest > edge) {
                    Bitmap smaller = Bitmap.createScaledBitmap(image,
                            Math.max(1, image.getWidth() * edge / longest),
                            Math.max(1, image.getHeight() * edge / longest), true);
                    if (smaller != image) image.recycle();
                    image = smaller;
                }
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                if (image.compress(Bitmap.CompressFormat.JPEG, 65, output) && output.size() <= 66000)
                    return output.toByteArray();
            }
            return null;
        } catch (RuntimeException error) {
            RuntimeLog.error("media_photo_preview_failed", error);
            return null;
        } finally {
            if (image != null) image.recycle();
        }
    }
}
