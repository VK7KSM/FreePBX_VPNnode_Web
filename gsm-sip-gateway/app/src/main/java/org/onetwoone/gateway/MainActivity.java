package org.onetwoone.gateway;

import android.os.Bundle;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.lifecycle.ViewModelProvider;

import org.onetwoone.gateway.config.GatewayConfig;
import org.onetwoone.gateway.ui.AudioDeviceManager;
import org.onetwoone.gateway.ui.MainViewModel;
import org.onetwoone.gateway.ui.PermissionManager;
import org.onetwoone.gateway.ui.TinymixManager;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Main activity for GSM-SIP Gateway.
 *
 * Responsibilities (UI only):
 * - Find views
 * - Setup observers for ViewModel LiveData
 * - Setup click handlers (delegate to ViewModel)
 * - Setup spinners
 */
public class MainActivity extends AppCompatActivity {
    private static final String TAG = "GatewayMain";
    private static final String[] CAPTURE_ROUTES = {
        GatewayConfig.AUDIO_ROUTE_UNCONFIGURED, "MultiMedia1", "MultiMedia4", "MultiMedia8"
    };
    private static final String[] INJECTION_ROUTES = {
        GatewayConfig.AUDIO_ROUTE_UNCONFIGURED, "MultiMedia1", "MultiMedia2", "MultiMedia5", "MultiMedia9"
    };

    private MainViewModel viewModel;

    // SIP config views
    private TextView statusText;
    private TextView permissionsText;
    private EditText sipServerEdit;
    private EditText sipPortEdit;
    private EditText sipUserEdit;
    private EditText sipPasswordEdit;
    private CheckBox useTlsCheckbox;
    private EditText sipRealmEdit;
    private EditText sim1DestinationEdit;
    private EditText sim2DestinationEdit;
    private RadioGroup incomingModeRadioGroup;
    private RadioButton modeAnswerFirst;
    private RadioButton modeSipFirst;
    private Button saveButton;
    private Button connectButton;
    private Button disconnectButton;

    // Audio config
    private Spinner cardSpinner;
    private Spinner captureSpinner;
    private Spinner playbackSpinner;
    private Spinner captureRouteSpinner;
    private Spinner injectionRouteSpinner;
    private EditText txGainEdit;
    private EditText rxGainEdit;
    private Button saveAudioButton;
    private Button restartButton;

    // Device mute preset
    private Spinner devicePresetSpinner;
    private LinearLayout customMuteContainer;
    private LinearLayout micMuteCheckboxContainer;
    private EditText manualMuteControlsEdit;
    private Map<String, CheckBox> decCheckboxes = new HashMap<>();

    // Selected values (for spinners)
    private int selectedCard = 0;
    private int selectedCaptureDevice = 0;
    private int selectedPlaybackDevice = 0;
    private String selectedCaptureRoute = GatewayConfig.PIXEL_CAPTURE_ROUTE;
    private String selectedInjectionRoute = GatewayConfig.PIXEL_INJECTION_ROUTE;
    private boolean isRefreshing = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        viewModel = new ViewModelProvider(this).get(MainViewModel.class);

        findViews();
        setupObservers();
        setupClickHandlers();
        setupSpinners();
        setupDevicePresetSpinner();

        // Initialize permissions via root
        viewModel.initPermissions();

        // Start service
        viewModel.startService();
    }

    @Override
    protected void onStart() {
        super.onStart();
        viewModel.bindToService();
        viewModel.startPolling();
        viewModel.refreshAudioDevices();
    }

    @Override
    protected void onStop() {
        super.onStop();
        viewModel.stopPolling();
        viewModel.unbindFromService();
    }

    // ========== View Setup ==========

    private void findViews() {
        statusText = findViewById(R.id.statusText);
        permissionsText = findViewById(R.id.permissionsText);
        sipServerEdit = findViewById(R.id.sipServer);
        sipPortEdit = findViewById(R.id.sipPort);
        sipUserEdit = findViewById(R.id.sipUser);
        sipPasswordEdit = findViewById(R.id.sipPassword);
        useTlsCheckbox = findViewById(R.id.useTls);
        sipRealmEdit = findViewById(R.id.sipRealm);
        saveButton = findViewById(R.id.saveButton);
        connectButton = findViewById(R.id.connectButton);
        disconnectButton = findViewById(R.id.disconnectButton);

        sim1DestinationEdit = findViewById(R.id.sim1Destination);
        sim2DestinationEdit = findViewById(R.id.sim2Destination);
        incomingModeRadioGroup = findViewById(R.id.incomingModeRadioGroup);
        modeAnswerFirst = findViewById(R.id.modeAnswerFirst);
        modeSipFirst = findViewById(R.id.modeSipFirst);

        cardSpinner = findViewById(R.id.cardSpinner);
        captureSpinner = findViewById(R.id.captureSpinner);
        playbackSpinner = findViewById(R.id.playbackSpinner);
        captureRouteSpinner = findViewById(R.id.captureRouteSpinner);
        injectionRouteSpinner = findViewById(R.id.injectionRouteSpinner);
        txGainEdit = findViewById(R.id.txGainEdit);
        rxGainEdit = findViewById(R.id.rxGainEdit);
        saveAudioButton = findViewById(R.id.saveAudioButton);
        restartButton = findViewById(R.id.restartButton);

        devicePresetSpinner = findViewById(R.id.devicePresetSpinner);
        customMuteContainer = findViewById(R.id.customMuteContainer);
        micMuteCheckboxContainer = findViewById(R.id.micMuteCheckboxContainer);
        manualMuteControlsEdit = findViewById(R.id.manualMuteControls);

    }

    private void setupObservers() {
        // Service state
        viewModel.getServiceState().observe(this, state -> {
            statusText.setText(state.statusMessage);
            statusText.setTextColor(state.isRegistered ? 0xFF228B22 : 0xFFCC0000);
            connectButton.setEnabled(!state.isRunning);
            disconnectButton.setEnabled(state.isRunning);
        });

        // SIP config
        viewModel.getSipConfig().observe(this, config -> {
            sipServerEdit.setText(config.server);
            sipPortEdit.setText(String.valueOf(config.port));
            sipUserEdit.setText(config.user);
            sipPasswordEdit.setText(config.password);
            sipRealmEdit.setText(config.realm);
            useTlsCheckbox.setChecked(config.useTls);
            sim1DestinationEdit.setText(config.sim1Destination);
            sim2DestinationEdit.setText(config.sim2Destination);

            if (config.incomingCallMode == GatewayInCallService.MODE_SIP_FIRST) {
                modeSipFirst.setChecked(true);
            } else {
                modeAnswerFirst.setChecked(true);
            }
        });

        // Audio config
        viewModel.getAudioConfig().observe(this, config -> {
            selectedCard = config.card;
            selectedCaptureDevice = config.captureDevice;
            selectedPlaybackDevice = config.playbackDevice;
            selectedCaptureRoute = config.captureRoute;
            selectedInjectionRoute = config.injectionRoute;
            txGainEdit.setText(String.valueOf(config.txGain));
            rxGainEdit.setText(String.valueOf(config.rxGain));
        });

        // Permission state
        viewModel.getPermissionState().observe(this, state -> {
            permissionsText.setText(state.toDisplayString());
        });

        // Audio devices
        viewModel.getAudioDevices().observe(this, this::updateAudioSpinners);

        // Mute preset
        viewModel.getShowCustomControls().observe(this, show -> {
            customMuteContainer.setVisibility(show ? View.VISIBLE : View.GONE);
        });

        // Manual mute controls text
        viewModel.getManualMuteControls().observe(this, controls -> {
            if (controls != null && !manualMuteControlsEdit.hasFocus()) {
                manualMuteControlsEdit.setText(controls);
            }
        });

        // Available mixer controls
        viewModel.getAvailableControls().observe(this, this::populateMuteCheckboxes);

        // Toast messages
        viewModel.getToastMessage().observe(this, msg -> {
            if (msg != null && !msg.isEmpty()) {
                Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void setupClickHandlers() {
        saveButton.setOnClickListener(v -> saveSipSettings());
        connectButton.setOnClickListener(v -> viewModel.startService());
        disconnectButton.setOnClickListener(v -> viewModel.stopService());
        saveAudioButton.setOnClickListener(v -> saveAudioConfig());
        restartButton.setOnClickListener(v -> viewModel.restartService());

        // Incoming call mode
        incomingModeRadioGroup.setOnCheckedChangeListener((group, checkedId) -> {
            int mode = (checkedId == R.id.modeSipFirst) ?
                GatewayInCallService.MODE_SIP_FIRST : GatewayInCallService.MODE_ANSWER_FIRST;
            GatewayConfig.getInstance().setIncomingCallMode(mode);
        });

    }

    private void setupSpinners() {
        // Card spinner
        cardSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (isRefreshing) return;
                if (selectedCard != position) {
                    selectedCard = position;
                    viewModel.getAudioDeviceManager().refreshDevices(position);
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        // Capture spinner
        captureSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                AudioDeviceManager.AudioDevices devices = viewModel.getAudioDevices().getValue();
                if (devices != null && position < devices.captureDevices.size()) {
                    selectedCaptureDevice = AudioDeviceManager.parseDeviceNumber(devices.captureDevices.get(position));
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        // Playback spinner
        playbackSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                AudioDeviceManager.AudioDevices devices = viewModel.getAudioDevices().getValue();
                if (devices != null && position < devices.playbackDevices.size()) {
                    selectedPlaybackDevice = AudioDeviceManager.parseDeviceNumber(devices.playbackDevices.get(position));
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        ArrayAdapter<String> captureRouteAdapter = new ArrayAdapter<>(this,
            android.R.layout.simple_spinner_item, CAPTURE_ROUTES);
        captureRouteAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        captureRouteSpinner.setAdapter(captureRouteAdapter);
        captureRouteSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position < CAPTURE_ROUTES.length) {
                    selectedCaptureRoute = CAPTURE_ROUTES[position];
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        ArrayAdapter<String> injectionRouteAdapter = new ArrayAdapter<>(this,
            android.R.layout.simple_spinner_item, INJECTION_ROUTES);
        injectionRouteAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        injectionRouteSpinner.setAdapter(injectionRouteAdapter);
        injectionRouteSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position < INJECTION_ROUTES.length) {
                    selectedInjectionRoute = INJECTION_ROUTES[position];
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
    }

    private void setupDevicePresetSpinner() {
        String[] presetNames = DeviceMuteManager.getPresetNames();
        String[] presetDescriptions = DeviceMuteManager.getPresetDescriptions();

        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
            android.R.layout.simple_spinner_item, presetDescriptions);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        devicePresetSpinner.setAdapter(adapter);

        // Load current preset
        String currentPreset = GatewayConfig.getInstance().getMutePreset();
        for (int i = 0; i < presetNames.length; i++) {
            if (presetNames[i].equals(currentPreset)) {
                devicePresetSpinner.setSelection(i);
                break;
            }
        }

        devicePresetSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position < presetNames.length) {
                    String selectedPreset = presetNames[position];
                    viewModel.selectMutePreset(selectedPreset);
                    Toast.makeText(MainActivity.this, "Preset: " + presetDescriptions[position], Toast.LENGTH_SHORT).show();
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
    }

    // ========== UI Updates ==========

    private void updateAudioSpinners(AudioDeviceManager.AudioDevices devices) {
        if (devices == null) return;
        isRefreshing = true;

        // Card spinner
        ArrayAdapter<String> cardAdapter = new ArrayAdapter<>(this,
            android.R.layout.simple_spinner_item, devices.cards);
        cardAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        cardSpinner.setAdapter(cardAdapter);
        if (selectedCard < devices.cards.size()) {
            cardSpinner.setSelection(selectedCard);
        }

        // Capture spinner
        ArrayAdapter<String> captureAdapter = new ArrayAdapter<>(this,
            android.R.layout.simple_spinner_item, devices.captureDevices);
        captureAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        captureSpinner.setAdapter(captureAdapter);
        int captureIndex = AudioDeviceManager.findDeviceIndex(devices.captureDevices, selectedCaptureDevice);
        if (captureIndex >= 0) {
            captureSpinner.setSelection(captureIndex);
        }

        // Playback spinner
        ArrayAdapter<String> playbackAdapter = new ArrayAdapter<>(this,
            android.R.layout.simple_spinner_item, devices.playbackDevices);
        playbackAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        playbackSpinner.setAdapter(playbackAdapter);
        int playbackIndex = AudioDeviceManager.findDeviceIndex(devices.playbackDevices, selectedPlaybackDevice);
        if (playbackIndex >= 0) {
            playbackSpinner.setSelection(playbackIndex);
        }

        for (int i = 0; i < CAPTURE_ROUTES.length; i++) {
            if (CAPTURE_ROUTES[i].equals(selectedCaptureRoute)) {
                captureRouteSpinner.setSelection(i);
                break;
            }
        }
        for (int i = 0; i < INJECTION_ROUTES.length; i++) {
            if (INJECTION_ROUTES[i].equals(selectedInjectionRoute)) {
                injectionRouteSpinner.setSelection(i);
                break;
            }
        }

        isRefreshing = false;
    }

    private void populateMuteCheckboxes(List<TinymixManager.MixerControl> controls) {
        micMuteCheckboxContainer.removeAllViews();
        decCheckboxes.clear();

        if (controls == null || controls.isEmpty()) {
            TextView noControlsText = new TextView(this);
            noControlsText.setText("No mixer controls found. Check root permissions.");
            noControlsText.setTextSize(12);
            noControlsText.setTextColor(0xFF999999);
            micMuteCheckboxContainer.addView(noControlsText);
            return;
        }

        Set<String> savedControls = GatewayConfig.getInstance().getMicMuteControls();

        for (TinymixManager.MixerControl control : controls) {
            CheckBox cb = new CheckBox(this);
            cb.setText(control.toString());
            cb.setTextSize(14);
            cb.setChecked(savedControls.contains(control.name));

            cb.setOnCheckedChangeListener((buttonView, isChecked) -> {
                viewModel.toggleMuteControl(control.name, isChecked);
            });

            decCheckboxes.put(control.name, cb);
            micMuteCheckboxContainer.addView(cb);
        }
    }

    // ========== Save Actions ==========

    private void saveSipSettings() {
        String server = sipServerEdit.getText().toString();
        int port = Integer.parseInt(sipPortEdit.getText().toString());
        String user = sipUserEdit.getText().toString();
        String password = sipPasswordEdit.getText().toString();
        String realm = sipRealmEdit.getText().toString();
        boolean useTls = useTlsCheckbox.isChecked();
        String sim1Dest = sim1DestinationEdit.getText().toString();
        String sim2Dest = sim2DestinationEdit.getText().toString();

        viewModel.saveSipConfig(server, port, user, password, realm, useTls, sim1Dest, sim2Dest);
    }

    private void saveAudioConfig() {
        Set<String> muteControls = new HashSet<>();
        for (Map.Entry<String, CheckBox> entry : decCheckboxes.entrySet()) {
            if (entry.getValue().isChecked()) {
                muteControls.add(entry.getKey());
            }
        }

        // Get manual controls
        String manualControls = manualMuteControlsEdit.getText().toString().trim();

        // Parse gain values
        float txGain = 0.0f;
        float rxGain = 0.0f;
        try {
            txGain = Float.parseFloat(txGainEdit.getText().toString());
        } catch (NumberFormatException ignored) {}
        try {
            rxGain = Float.parseFloat(rxGainEdit.getText().toString());
        } catch (NumberFormatException ignored) {}

        viewModel.saveAudioConfig(selectedCard, selectedCaptureDevice, selectedPlaybackDevice,
            selectedCaptureRoute, selectedInjectionRoute,
            txGain, rxGain, muteControls, manualControls);
    }
}
