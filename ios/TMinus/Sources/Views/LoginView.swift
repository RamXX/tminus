// LoginView.swift
// T-Minus iOS -- Login screen with email/password fields.
//
// Walking skeleton: simple email+password login against the T-Minus API.
// Future: ASWebAuthenticationSession for OAuth flows (Google/Microsoft).

import SwiftUI

struct LoginView: View {
    @ObservedObject var viewModel: AuthViewModel

    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                // Logo / Title
                VStack(spacing: 8) {
                    Text("T-Minus")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    Text("Unified Calendar")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                // Input Fields
                VStack(spacing: 16) {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        .autocapitalization(.none)
                        #endif
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("emailField")

                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("passwordField")
                }
                .padding(.horizontal)

                // Error message
                if let error = viewModel.errorMessage {
                    Text(error)
                        .foregroundColor(.red)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                        .accessibilityIdentifier("errorLabel")
                }

                // Login Button
                Button {
                    Task {
                        await viewModel.login(email: email, password: password)
                    }
                } label: {
                    if viewModel.isLoading {
                        ProgressView()
                            .progressViewStyle(.circular)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Sign In")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.isLoading || email.isEmpty || password.isEmpty)
                .padding(.horizontal)
                .accessibilityIdentifier("loginButton")

                Spacer()
            }
            .navigationTitle("Sign In")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
    }
}
